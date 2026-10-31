/**
 * Owner binding. Either pinned by config.owner.qq, or learned from the first
 * private sender and persisted to data/owner.json.
 * @module dsh-onebot/standalone/owner
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface OwnerFile {
  qq: string
  boundAt: number
}

export class OwnerStore {
  private readonly dir: string
  private readonly configured: string
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  private qq = ''

  constructor(
    dataDir: string,
    configuredQQ: string,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  ) {
    this.dir = dataDir
    this.configured = configuredQQ
    this.log = log
  }

  async load(): Promise<void> {
    if (this.configured !== '') {
      this.qq = this.configured
      return
    }
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'owner.json'), 'utf8')) as Partial<OwnerFile>
      if (typeof raw.qq === 'string' && /^\d{5,12}$/.test(raw.qq)) {
        this.qq = raw.qq
        this.log('info', `已从 data/owner.json 恢复主人 QQ: ${this.qq}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', `读取 owner.json 失败，将重新绑定: ${describe(error)}`)
      }
    }
  }

  current(): string {
    return this.qq
  }

  /** Bind the first sender. Returns false when already bound. */
  async bind(qq: string): Promise<boolean> {
    if (this.qq !== '') return this.qq === qq
    if (!/^\d{5,12}$/.test(qq)) return false
    this.qq = qq
    await this.persist()
    return true
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const file = join(this.dir, 'owner.json')
      const temp = file + '.tmp'
      const data: OwnerFile = { qq: this.qq, boundAt: Date.now() }
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
      await rename(temp, file)
      this.log('info', `主人已绑定: ${this.qq}（写入 data/owner.json，之后只认这个号）`)
    } catch (error) {
      this.log('warn', `保存 owner.json 失败（本次运行仍生效）: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
