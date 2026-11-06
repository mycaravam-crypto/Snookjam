import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('architecture', () => {
  it('keeps src/game independent of Vue and the app layer', () => {
    const offenders = files(join(__dirname, '../../src/game')).filter((file) =>
      /from\s+['"](vue|@vue\/|@app\/|\.\.\/app)/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
