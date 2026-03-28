/**
 * Custom Jest transformer that patches import.meta.server to false before
 * delegating to ts-jest. Required because Jest runs in Node.js CJS mode where
 * import.meta is not a valid syntax construct.
 */

'use strict'

const tsJest = require('ts-jest')

// Keyed by stable JSON of transformerConfig to handle different configs per file set
const _transformerCache = new Map()

function getTransformer(transformerConfig) {
  const key = JSON.stringify(transformerConfig || {})
  if (!_transformerCache.has(key)) {
    _transformerCache.set(key, tsJest.default.createTransformer(transformerConfig || {}))
  }
  return _transformerCache.get(key)
}

function patchSource(sourceText, sourcePath) {
  // Skip test files — they may contain the literal string 'import.meta.server'
  // in expectations and we don't want those replaced
  if (
    sourcePath.includes('/tests/') ||
    sourcePath.includes('/test/') ||
    sourcePath.endsWith('.spec.ts') ||
    sourcePath.endsWith('.test.ts')
  ) {
    return sourceText
  }
  // Replace import.meta.server with a globalThis flag so individual tests can
  // control the value: set globalThis.__JEST_IS_SERVER__ = true in a describe
  // block to exercise the SSR branch, leave it undefined/false for the client branch.
  return sourceText
    .replace(/\bimport\.meta\.server\b/g, '(globalThis.__JEST_IS_SERVER__ === true)')
    .replace(/\bimport\.meta\.client\b/g, '(globalThis.__JEST_IS_SERVER__ !== true)')
}

module.exports = {
  process(sourceText, sourcePath, options) {
    const patched = patchSource(sourceText, sourcePath)
    return getTransformer(options.transformerConfig).process(patched, sourcePath, options)
  },

  processAsync(sourceText, sourcePath, options) {
    const patched = patchSource(sourceText, sourcePath)
    const t = getTransformer(options.transformerConfig)
    if (t.processAsync) {
      return t.processAsync(patched, sourcePath, options)
    }
    return Promise.resolve(t.process(patched, sourcePath, options))
  },
}
