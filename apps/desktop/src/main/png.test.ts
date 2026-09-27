import { visionFixture } from '@jupiter/testing/vision'
import { describe, expect, it } from 'vitest'
import { blackOut, changedFraction, crop, decodePng, encodePng, pngSize } from './png'
import { parseTesseractTsv, parseZbarXml } from './vision-host'

describe('PNG reader and writer (SET 13)', () => {
  it('reads a real PNG and writes one that reads back to the same pixels', () => {
    const bitmap = decodePng(visionFixture('form'))
    expect(pngSize(visionFixture('form'))).toEqual({ width: 900, height: 360 })
    expect(bitmap.rgba.length).toBe(900 * 360 * 4)
    // The top-left corner is white; the title text is dark.
    expect([...bitmap.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    const again = decodePng(encodePng(bitmap))
    expect(again.width).toBe(900)
    expect(Buffer.from(again.rgba).equals(Buffer.from(bitmap.rgba))).toBe(true)
  })

  it('crops, blacks out and compares on real pixels', () => {
    const form = decodePng(visionFixture('form'))
    const part = crop(form, { x: 40, y: 200, width: 400, height: 40 })
    expect([part.width, part.height]).toEqual([400, 40])
    // Cropping past the edge keeps only what is inside the image.
    expect(crop(form, { x: 800, y: 300, width: 500, height: 500 })).toMatchObject({
      width: 100,
      height: 60
    })
    expect(() => crop(form, { x: 1000, y: 0, width: 10, height: 10 })).toThrow('outside')
    const masked = blackOut(form, [{ x: 0, y: 0, width: 10, height: 10 }])
    expect([...masked.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255])
    // The original is untouched.
    expect([...form.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    expect(changedFraction(form, form)).toBe(0)
    const before = decodePng(visionFixture('before'))
    const after = decodePng(visionFixture('after'))
    const fraction = changedFraction(before, after) ?? 0
    expect(fraction).toBeGreaterThan(0.005)
    expect(fraction).toBeLessThan(0.2)
    expect(changedFraction(before, form)).toBeNull()
  })

  it('refuses what is not a PNG', () => {
    expect(() => decodePng(Buffer.from('GIF89a not a png'))).toThrow('Not a PNG')
    const broken = Buffer.from(visionFixture('qr'))
    expect(() => decodePng(broken.subarray(0, 60))).toThrow()
  })
})

describe('OCR and QR output parsing', () => {
  it('groups Tesseract words into lines with their mean confidence and box', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t20\t50\t10\t90\tHello',
      '5\t1\t1\t1\t1\t2\t70\t18\t60\t14\t70\tJupiter',
      '5\t1\t1\t1\t1\t3\t0\t0\t0\t0\t95\t ',
      '5\t1\t1\t1\t2\t1\t10\t40\t30\t10\t-1\tignored',
      '4\t1\t1\t1\t1\t0\t10\t18\t120\t14\t-1\t'
    ].join('\n')
    expect(parseTesseractTsv(tsv)).toEqual([
      { text: 'Hello Jupiter', confidence: 0.8, box: { x: 10, y: 18, width: 120, height: 14 } }
    ])
  })

  it('reads zbar XML: the value, its type and where it is', () => {
    const xml =
      "<barcodes><source><index num='0'><symbol type='QR-Code' quality='1'><polygon points='+31,+31 +31,+264 +265,+265 +264,+31'/><data><![CDATA[https://example.com/a]]></data></symbol></index></source></barcodes>"
    expect(parseZbarXml(xml)).toEqual([
      {
        value: 'https://example.com/a',
        kind: 'QR-Code',
        box: { x: 31, y: 31, width: 234, height: 234 }
      }
    ])
    expect(parseZbarXml('<barcodes></barcodes>')).toEqual([])
  })
})
