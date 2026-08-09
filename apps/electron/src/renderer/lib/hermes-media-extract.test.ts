import { describe, expect, test } from 'bun:test'
import { extractHermesFiles, extractHermesMedia, isImagePathLike, stripHermesAttachmentDirectives } from './hermes-media-extract'

describe('extractHermesMedia', () => {
  test('data URL 图片', () => {
    const text = '看图：data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA= 完毕'
    const refs = extractHermesMedia(text)
    expect(refs.length).toBe(1)
    expect(refs[0]!.dataUrl).toContain('data:image/png;base64,')
  })

  test('MEDIA: token（远端路径）', () => {
    const refs = extractHermesMedia('生成了 MEDIA:/home/ai/.hermes/images/foo.png')
    expect(refs.length).toBe(1)
    expect(refs[0]!.remotePath).toBe('/home/ai/.hermes/images/foo.png')
  })

  test('绝对路径图片', () => {
    const refs = extractHermesMedia('图片在 /tmp/bar.png 这里')
    expect(refs.length).toBe(1)
    expect(refs[0]!.remotePath).toBe('/tmp/bar.png')
  })

  test('http 图片 URL', () => {
    const refs = extractHermesMedia('http://host:8642/api/media?path=/home/ai/.hermes/images/x.png')
    expect(refs.length).toBe(1)
    expect(refs[0]!.remotePath).toContain('/api/media')
  })

  test('@image: 指令（Hermes 持久化消息标准格式）', () => {
    const refs = extractHermesMedia('看这张图\n\n@image:/home/ai/.hermes/images/upload_1.png')
    expect(refs.length).toBe(1)
    expect(refs[0]!.remotePath).toBe('/home/ai/.hermes/images/upload_1.png')
  })

  test('@image: 与文字混排', () => {
    const refs = extractHermesMedia('附件\n@image:/tmp/a.png 说明文字')
    expect(refs.length).toBe(1)
    expect(refs[0]!.remotePath).toBe('/tmp/a.png')
  })

  test('无图片时不返回', () => {
    expect(extractHermesMedia('只是普通文本')).toEqual([])
  })

  test('路径与文本混排去重', () => {
    const refs = extractHermesMedia('a.png b.png a.png')
    // 无扩展名的裸文件名不匹配（非绝对路径）
    expect(refs).toEqual([])
  })

  test('isImagePathLike', () => {
    expect(isImagePathLike('/x/y.png')).toBe(true)
    expect(isImagePathLike('/x/y.txt')).toBe(false)
    expect(isImagePathLike('/x/y.png?size=100')).toBe(true)
  })
})

describe('Hermes attachment directives', () => {
  test('@file 支持普通与带空格的 quoted 路径', () => {
    expect(extractHermesFiles('@file:.hermes/desktop-attachments/a.xlsx')).toEqual([
      { name: 'a.xlsx', remotePath: '.hermes/desktop-attachments/a.xlsx' },
    ])
    expect(extractHermesFiles('@file:`.hermes/desktop-attachments/my report.xlsx`')[0]).toEqual({
      name: 'my report.xlsx',
      remotePath: '.hermes/desktop-attachments/my report.xlsx',
    })
  })

  test('展示正文剥离 image/file 指令但保留用户文字', () => {
    expect(stripHermesAttachmentDirectives('请分析\n@image:/remote/a.png\n@file:`.hermes/a b.xlsx`')).toBe('请分析')
  })

  test('剥离 file.attach 注入的 Attached Context', () => {
    expect(stripHermesAttachmentDirectives(
      '请分析表格\n@file:.hermes/a.xlsx\n\n--- Attached Context ---\n📎 binary file, available at /remote/a.xlsx',
    )).toBe('请分析表格')
  })

  test('图片指令存在时剥离 Hermes 的 [screenshot] 展示哨兵', () => {
    expect(stripHermesAttachmentDirectives('@image:/remote/a.png\n[screenshot]')).toBe('')
    expect(stripHermesAttachmentDirectives('[screenshot]')).toBe('[screenshot]')
  })
})
