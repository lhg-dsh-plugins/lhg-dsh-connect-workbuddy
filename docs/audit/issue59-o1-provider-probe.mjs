// Issue #59 — why O1 ("stamp one shared model.provider") cannot ship as a one-line change.
// Run: node docs/audit/issue59-o1-provider-probe.mjs
// Expects the host bundle at the path below (extracted from app.asar).
// Result: a model stamped with a provider id that its own registry lacks produces
//   stopReason "error" / "Unknown provider: <id>" before any request is sent.

const P = '/private/tmp/asar-full/dsh/node_modules/@earendil-works/pi-ai/dist'
const { createModels } = await import(P + '/models.js')
const mk = (id) => ({ id, name: id, auth: { apiKey: { name: 'k', resolve: async () => ({ auth: { apiKey: 'x' } }) } },
  getModels: () => [{ id: 'm1', provider: id, api: 'openai-completions', baseUrl: 'http://localhost:1/v1' }],
  stream: () => { throw new Error('WOULD-STREAM'); }, streamSimple: () => { throw new Error('WOULD-STREAM'); } })

const models = createModels(undefined)
models.setProvider(mk('workbuddy-global'))
const own = models.getModel('workbuddy-global', 'm1')

for (const [label, m] of [['own id (today)', own], ['stamped "workbuddy" (O1)', { ...own, provider: 'workbuddy' }]]) {
  const stream = models.streamSimple(m, { messages: [] }, {})
  const events = []
  for await (const ev of stream) events.push(ev.type)
  const final = await stream.result()
  console.log(label)
  console.log('   events:', events.join(','), '| stopReason:', final.stopReason, '| error:', final.errorMessage)
}
