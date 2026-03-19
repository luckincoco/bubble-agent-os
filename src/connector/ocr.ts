import { logger } from '../shared/logger.js'

export interface OCRResult {
  text: string
  regions: Array<{ text: string; confidence: number }>
  averageConfidence: number
}

export async function recognizeImage(
  imageBuffer: Buffer,
  config: { secretId: string; secretKey: string; region?: string },
): Promise<OCRResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tencentcloud = (await import(/* @vite-ignore */ 'tencentcloud-sdk-nodejs-ocr' as string)).default as any
  const OcrClient = tencentcloud.ocr.v20181119.Client

  const client = new OcrClient({
    credential: { secretId: config.secretId, secretKey: config.secretKey },
    region: config.region || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
  })

  const base64 = imageBuffer.toString('base64')

  const resp = await client.GeneralBasicOCR({ ImageBase64: base64 })
  const detections: Array<{ DetectedText?: string; Confidence?: number }> = resp.TextDetections || []

  if (detections.length === 0) {
    return { text: '', regions: [], averageConfidence: 0 }
  }

  const regions = detections.map((d) => ({
    text: d.DetectedText || '',
    confidence: d.Confidence || 0,
  }))

  const text = regions.map((r: { text: string }) => r.text).join('\n')
  const totalConf = regions.reduce((sum: number, r: { confidence: number }) => sum + r.confidence, 0)
  const averageConfidence = totalConf / regions.length

  logger.info(`OCR: recognized ${regions.length} regions, avg confidence ${averageConfidence.toFixed(1)}%`)

  return { text, regions, averageConfidence }
}
