import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist'

export type Source = Parameters<typeof getDocument>[0] | PDFDocumentProxy | null

export type PasswordRequestParams = {
  callback: Function
  isWrongPassword: boolean
}

export interface TextractBoundingBox {
  // Normalized 0..1
  Left: number
  Top: number
  Width: number
  Height: number
}

export interface TextractGeometry {
  BoundingBox?: TextractBoundingBox
}

export interface TextractBlock {
  BlockType?: string
  Page?: number
  Text?: string
  Geometry?: TextractGeometry
}

export interface TextractBlocksApiResponse {
  textract_blocks: TextractBlock[]
}
