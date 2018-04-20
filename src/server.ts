import * as http from 'http';
import { ivm } from './'
import * as url from 'url';
import * as net from 'net';
import * as fs from 'fs';
import * as zlib from 'zlib';
import log from './log'
import { Trace } from './trace';
import * as httpUtils from './utils/http'
import { Readable, Writable, Transform } from 'stream'
import { Context } from './context'
import { App } from './app'

import EventEmitter = require('events')
import { DefaultContextStore } from './default_context_store';

import { bufferToStream, transferInto } from './utils/buffer'
import { ProxyStream } from './bridge/proxy_stream';
import { TLSSocket } from 'tls';
import { FileAppStore } from './file_app_store';
import { Bridge } from './bridge/bridge';
import { LocalFileStore } from './local_file_store';
import { randomBytes } from 'crypto';

const defaultFetchDispatchTimeout = 1000
const defaultFetchEndTimeout = 5000

const hopHeaders = [
	// From RFC 2616 section 13.5.1
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"TE",
	"Trailers",
	"Transfer-Encoding",
	"Upgrade",

	// We don't want to trigger upstream HTTPS redirect
	"Upgrade-Insecure-Requests"
]

export interface RequestMeta {
	app?: App,
	startedAt?: [number, number], //process.hrtime() ya know
	endedAt?: [number, number],
	id?: string,
	originalURL?: string,
}

declare module 'http' {
	interface IncomingMessage {
		protocol: string
	}
}

export interface ServerOptions {
	contextStore?: DefaultContextStore
	appStore?: FileAppStore
	bridge?: Bridge
}

export interface RequestTask {
	request: http.IncomingMessage
	response: http.ServerResponse
}

export class Server extends http.Server {
	options: ServerOptions

	bridge: Bridge
	contextStore: DefaultContextStore
	appStore: FileAppStore

	constructor(options: ServerOptions = {}) {
		super()
		this.options = options
		this.appStore = options.appStore || new FileAppStore(process.cwd())
		this.bridge = options.bridge || new Bridge({ fileStore: new LocalFileStore(process.cwd(), this.appStore.release) })
		this.contextStore = options.contextStore || new DefaultContextStore()
		this.on("request", this.handleRequest.bind(this))
		this.on("listening", () => {
			const addr = this.address()
			console.log(`Server listening on ${addr.address}:${addr.port}`)
		})
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
		request.pause()
		const startedAt = process.hrtime()
		const trace = Trace.start("httpRequest")
		if (request.url === undefined) // wtf
			return

		if (request.headers.host === undefined)
			return

		if (request.url == undefined) { // that can't really happen?
			return
		}

		request.protocol = 'http:'

		const app = this.appStore.app;

		if (!app.source) {
			response.writeHead(400)
			response.end("app has no source")
			return
		}

		const contextErrorHandler = (err: Error) => {
			handleCriticalError(err, request, response)
		}

		let t = trace.start("acquireContext")
		let ctx: Context
		try {
			ctx = await this.contextStore.getContext(app, this.bridge, t)
		} catch (err) {
			handleCriticalError(err, request, response)
			return
		}
		t.end()
		ctx.trace = trace
		Object.assign(ctx.logMetadata, {
			method: request.method,
			remote_addr: request.connection.remoteAddress,
			user_agent: request.headers['user-agent']
		})

		ctx.once("error", contextErrorHandler)

		request.headers['x-request-id'] = randomBytes(12).toString('hex')

		try {
			await handleRequest(app, ctx, request, response, trace)
		} catch (err) {
			log.error("error handling request:", err.stack)
		} finally {
			ctx.removeListener('error', contextErrorHandler)
			this.contextStore.putContext(ctx)
			trace.end()
			log.debug(trace.report())
		}
	}

}

type V8ResponseBody = null | string | ArrayBuffer | Buffer | ivm.Reference<ProxyStream>

export function handleRequest(app: App, ctx: Context, req: http.IncomingMessage, res: http.ServerResponse, ptrace?: Trace) {

	let trace = Trace.start("handleRequest", ptrace)
	let t: Trace;

	let flyDepth = 0
	let flyDepthHeader = <string>req.headers["x-fly-depth"]
	if (flyDepthHeader) {
		flyDepth = parseInt(flyDepthHeader)
		if (isNaN(flyDepth) || flyDepth < 0) {
			flyDepth = 0
		}
	}

	const fullURL = httpUtils.fullURL(req.protocol, req)

	Object.assign(ctx.meta, {
		app: app,

		requestId: req.headers['x-request-id'],
		originalScheme: req.protocol,
		originalHost: req.headers.host,
		originalPath: req.url,
		originalURL: fullURL,
		flyDepth: flyDepth
	})

	t = Trace.tryStart("fetchEvent", ctx.trace)
	ctx.trace = t
	let cbCalled = false
	return new Promise((resolve, reject) => { // mainly to make try...finally work
		let reqForV8 = {
			method: req.method,
			headers: req.headers,
			remoteAddr: req.connection.remoteAddress
		}

		let fetchCallback = (err: any, v8res: any, resBody: V8ResponseBody) => {
			if (cbCalled) {
				return // this can't happen twice
			}
			cbCalled = true
			t.end()
			ctx.trace = t.parent

			if (err) {
				log.error("error from fetch callback:", err)
				writeHead(ctx, res, 500)
				res.end("Error: " + err)
				return
			}

			for (let n in v8res.headers) {
				try {
					n = n.trim()
					if (/^server$/i.test(n))
						continue

					const val = v8res.headers[n]

					//console.log("setting header", n, val)
					res.setHeader(n, val)
				} catch (err) {
					log.error("error setting header", err)
				}
			}

			for (let n of hopHeaders)
				res.removeHeader(n)

			let dst: Writable = res
			let contentEncoding = res.getHeader("content-encoding")
			let contentType = res.getHeader("content-type")
			let acceptEncoding = req.headers['accept-encoding']
			if (acceptEncoding && acceptEncoding instanceof Array) {
				acceptEncoding = acceptEncoding.join(", ")
			}

			// gzip if no encoding
			if (!contentEncoding && contentType && acceptEncoding && acceptEncoding.includes("gzip")) {
				if (contentType && contentType instanceof Array) {
					contentType = contentType.join(", ")
				} else {
					contentType = contentType.toString()
				}
				// only gzip text
				if (contentType.includes("text/") || contentType.includes("application/javascript")) {
					res.removeHeader("Content-Length")
					res.setHeader("Content-Encoding", "gzip")
					//res.setHeader("Content-Type", contentType)
					dst = zlib.createGzip({ level: 2 })
					dst.pipe(res)
				}
			}

			writeHead(ctx, res, v8res.status)

			handleResponse(resBody, dst).then((len) => {
				if (ptrace)
					ptrace.addTags({ dataOut: len, dataIn: 0 })
				if (!res.finished)
					res.end() // we are done. triggers 'finish' event
				ctx.log('info', `${req.connection.remoteAddress} ${req.method} ${fullURL} ${res.statusCode} ${Math.round(trace.milliseconds() * 100) / 100}ms`)
			}).then(() => resolve()).catch((e) => reject(e))
		}

		ctx.fireFetchEvent([
			fullURL,
			new ivm.ExternalCopy(reqForV8).copyInto({ release: true }),
			req.method === 'GET' || req.method === 'HEAD' ? null : new ProxyStream(req).ref,
			new ivm.Reference(fetchCallback)
		]).catch(reject)
	})
}

function handleResponse(src: V8ResponseBody, dst: Writable): Promise<number> {
	if (!src)
		return Promise.resolve(0)

	if (src instanceof ivm.Reference) {
		console.log("body is a stream, streamking")
		return handleResponseStream(src.deref({ release: true }), dst)
	}

	let totalLength = 0

	if (src instanceof ArrayBuffer)
		src = Buffer.from(src)

	const p = new Promise<number>((resolve, reject) => {
		dst.on("close", () => {
			console.log("dest closed")
			if (src instanceof Buffer)
				totalLength = src.byteLength
			else if (typeof src === 'string')
				totalLength = Buffer.byteLength(src, 'utf8')
			resolve(totalLength)
		})
		dst.on("error", (err) => {
			reject(err)
		})
	})

	dst.end(src) // string or Buffer

	return p
	//return Promise.resolve(totalLength)
}

function handleResponseStream(src: ProxyStream, dst: Writable): Promise<number> {
	return new Promise(function (resolve, reject) {
		setImmediate(() => {
			let dataOut = 0
			dst.on("data", function (d) {
				dataOut += d.byteLength
			})
			dst.on("close", function () {
				resolve(dataOut)
			}).on("error", reject)
			for (const c of src.buffered) {
				dst.write(c)
			}
			src.stream.pipe(dst)
		})
	})
}

function handleCriticalError(err: Error, req: http.IncomingMessage, res: http.ServerResponse) {
	log.error("critical error:", err)
	if (res.finished)
		return
	res.writeHead(500)
	res.end("Critical error.")
	req.destroy() // stop everything I guess.
}

function writeHead(ctx: Context, res: http.ServerResponse, status: number) {
	ctx.logMetadata.status = status
	res.writeHead(status)
}
