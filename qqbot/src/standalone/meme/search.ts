/**
 * Pure sticker search and selection. Mirrors dsh-meme's approach: mood buckets
 * plus keyword scoring, with a bigram fallback for long Chinese queries; ties
 * prefer the least-recently-used images so the same sticker does not repeat.
 * @module dsh-onebot/standalone/meme/search
 */

export interface SearchableMeme {
  path: string
  name: string
  tags: string[]
  caption: string
  keywords: string[]
  lastUsedAt: number
}

/** Common Chinese mood words mapped onto the folder tags. */
export const TAG_ALIASES: Record<string, string[]> = {
  happy: ['开心', '高兴', '快乐', '笑', '笑脸', '嘻嘻', '好耶', '比心', '可爱'],
  angry: ['生气', '愤怒', '火大', '气死', '嫌弃'],
  sad: ['难过', '伤心', '哭', '委屈', 'emo', '叹气', '无语'],
  shy: ['害羞', '不好意思', '脸红', '羞'],
  confused: ['困惑', '疑惑', '问号', '不懂', '茫然', '震惊'],
  daily: ['日常', '随便', '普通', '摸鱼'],
  work: ['工作', '加班', '打工', '累', '上班'],
  sleep: ['睡觉', '困', '晚安', '熬夜', '睡'],
}

export function expandTags(tag: string): string[] {
  const value = tag.trim().toLowerCase()
  if (value === '') return []
  const tags = new Set<string>([value])
  for (const [key, aliases] of Object.entries(TAG_ALIASES)) {
    if (key === value || value.includes(key) || aliases.some(alias => value.includes(alias) || alias.includes(value))) {
      tags.add(key)
    }
  }
  return [...tags]
}

/** Split a query on spaces/punctuation; Chinese words stay whole. */
export function tokenizeQuery(query: string): string[] {
  const raw = query.trim().toLowerCase()
  if (raw === '') return []
  return [...new Set(raw.split(/[\s,，、;；/|]+/).filter(Boolean))]
}

/** Fallback for long Chinese tokens: 「生气猫」→ 生气 / 气猫. */
export function biGrams(tokens: readonly string[]): string[] {
  const out: string[] = []
  for (const token of tokens) {
    if (token.length < 3 || !/[一-鿿]/.test(token)) continue
    for (let index = 0; index + 2 <= token.length; index += 1) out.push(token.slice(index, index + 2))
  }
  return [...new Set(out)]
}

function haystack(entry: SearchableMeme): string {
  return `${entry.caption} ${entry.keywords.join(' ')} ${entry.name} ${entry.tags.join(' ')}`.toLowerCase()
}

function scorePool<T extends SearchableMeme>(pool: readonly T[], tokens: readonly string[]): Array<{ entry: T; score: number }> {
  const hits: Array<{ entry: T; score: number }> = []
  for (const entry of pool) {
    const hay = haystack(entry)
    let score = 0
    for (const token of tokens) if (hay.includes(token)) score += 1
    if (score > 0) hits.push({ entry, score })
  }
  return hits
}

export interface MemeFilter {
  tag?: string
  mood?: string
  query?: string
}

/**
 * Scope by mood/tag, then rank by how many query tokens hit. Returns the
 * best-scoring pool (unsorted); an empty array means the query matched nothing.
 */
export function filterMemes<T extends SearchableMeme>(entries: readonly T[], filter: MemeFilter): T[] {
  let pool = [...entries]

  const scope = [filter.tag, filter.mood]
    .map(value => (value ?? '').trim())
    .filter(value => value !== '')
  if (scope.length > 0) {
    const wanted = new Set(scope.flatMap(expandTags))
    const scoped = pool.filter(entry => entry.tags.some(tag => wanted.has(tag)
      || [...wanted].some(candidate => tag.includes(candidate))))
    if (scoped.length > 0) pool = scoped
  }

  const query = (filter.query ?? '').trim()
  if (query === '') return pool

  const tokens = tokenizeQuery(query)
  let hits = scorePool(pool, tokens)
  if (hits.length === 0) hits = scorePool(pool, biGrams(tokens))
  if (hits.length === 0) return []

  const best = Math.max(...hits.map(hit => hit.score))
  return hits.filter(hit => hit.score === best).map(hit => hit.entry)
}

export interface ChooseOptions {
  now?: number
  avoidRepeatMs?: number
  random?: () => number
}

/**
 * Prefer the least-recently-used images. Images used inside `avoidRepeatMs`
 * are skipped when any fresher alternative exists; among the oldest third the
 * choice is random, so repeated searches rotate instead of picking one file.
 */
export function chooseLeastRecent<T extends { lastUsedAt: number }>(
  pool: readonly T[],
  options: ChooseOptions = {},
): T | undefined {
  if (pool.length === 0) return undefined
  const now = options.now ?? Date.now()
  const avoid = Math.max(0, options.avoidRepeatMs ?? 0)
  const random = options.random ?? Math.random
  const fresh = avoid > 0 ? pool.filter(entry => now - entry.lastUsedAt >= avoid) : pool
  if (fresh.length > 0) {
    const sorted = [...fresh].sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    const window = Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length / 3)))
    return sorted[Math.floor(random() * window)]
  }
  // Everything was used recently: rotate through the least-recently-used group.
  const oldest = Math.min(...pool.map(entry => entry.lastUsedAt))
  const tied = pool.filter(entry => entry.lastUsedAt === oldest)
  return tied[Math.floor(random() * tied.length)]
}
