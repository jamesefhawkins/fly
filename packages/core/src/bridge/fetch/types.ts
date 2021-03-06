import { URL } from "url"

export { URL }

export interface RequestInit {
  method?: string
  timeout?: number
  readTimeout?: number
  headers?: Record<string, string>
  certificate?: Certificate
  tls?: {
    servername?: string
  }
}

export type FetchBody = string | number | ArrayBuffer | Buffer | null

export interface ResponseInit {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: number | string
}

export interface Certificate {
  key?: string | Buffer | Array<string | Buffer>
  cert?: string | Buffer | Array<string | Buffer>
  ca?: string | Buffer | Array<string | Buffer>
  pfx?: string | Buffer | Array<string | Buffer>
  passphrase?: string
}
