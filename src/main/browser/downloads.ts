import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { session, type DownloadItem as ElectronDownloadItem } from 'electron'
import type { DownloadItem } from '@shared/schemas.js'
import { emit } from '../core/events.js'
import { log } from '../core/logger.js'
import { loadSettings } from '../core/settings.js'

/** Basic downloads: start, track progress, report where the file landed. */

const items = new Map<string, DownloadItem>()

export function initDownloads(): void {
  session.defaultSession.on('will-download', (_event, item: ElectronDownloadItem) => {
    const id = randomUUID()
    const dir = loadSettings().downloadDir
    const filename = item.getFilename()
    const savePath = dir ? join(dir, filename) : item.getSavePath()
    if (dir) item.setSavePath(savePath)

    const record: DownloadItem = {
      id,
      filename,
      url: item.getURL(),
      savePath,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now()
    }
    items.set(id, record)
    log.info('BROWSER', `Download started: ${filename}`, { url: record.url, savePath })
    publish()

    item.on('updated', (_e, state) => {
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      publish()
    })

    item.once('done', (_e, state) => {
      record.state =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      record.receivedBytes = item.getReceivedBytes()
      record.savePath = item.getSavePath() || record.savePath
      if (state === 'completed') {
        log.info('BROWSER', `Download finished: ${filename}`, { savePath: record.savePath })
      } else {
        log.warn('BROWSER', `Download ${state}: ${filename}`, { url: record.url })
      }
      publish()
    })
  })
}

export function listDownloads(): DownloadItem[] {
  return [...items.values()].sort((a, b) => b.startedAt - a.startedAt)
}

function publish(): void {
  emit('browser:downloads', listDownloads())
}
