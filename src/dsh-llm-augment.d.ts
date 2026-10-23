/**
 * Module augmentation for `MessageSourceMap`.
 *
 * `MessageSource` is `MessageSourceMap[keyof MessageSourceMap]`, and the map is
 * MERGE-EXTENSIBLE on purpose — `@deepseek-ai/dsh-llm`'s own doc comment on it
 * reads: "each producer declares its own `kind` in its own module; there is no
 * shared catch-all `plugin` kind … consumers fall through unknown kinds."
 *
 * So a plugin that puts a message in front of the model declares its own kind
 * here instead of borrowing `'user'`. `'user'` is not a neutral default: it is a
 * claim that the user typed this, and the transcript renders it that way (the
 * injected result shows up in the user bubble, right-aligned, indistinguishable
 * from something the human wrote).
 *
 * `dsh-connect-atomcode` does the same thing with `'atomcode-bridge'`.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codebuddy-bridge': {
      kind: 'codebuddy-bridge'
    }
  }
}

export {}
