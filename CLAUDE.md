# Agent instructions

## GitHub

Use `mcp__github__*` MCP tools for all GitHub operations — PRs, issues, comments, reading files.
Never use the `gh` CLI.

The MCP server is pre-configured in `.mcp.json` (token via `$AGNIC_GH_TOKEN`).
Repo owner: `FominSergiy`, repo name: `agnic-agent-wallet-verifier`.

## agent docs

all lives under docs

### plans

to be executed plans are saved under plans/planned
all done plans are put under plans/completed


## Project tools

**Runtime:** Deno. Binary: `~/.deno/bin/deno`. All tasks are in `deno.json`.

| Task | Command |
|------|---------|
| Dev server (watch) | `deno task dev` |
| Run tests | `deno task test` |
| Lint | `deno task lint` |
| Type-check | `deno task check` |

When working in a worktree or targeting specific files, use the binary directly:

```bash
~/.deno/bin/deno check <file>.ts <file>_test.ts
~/.deno/bin/deno lint <file>.ts <file>_test.ts
~/.deno/bin/deno test --allow-net --allow-env <file>_test.ts
```

**Env vars:** copy `.env.example` → `.env`. `OPENROUTER_API_KEY` is required for any LLM call.
never commit env vars.


### Agnic routes

#### sample sdk code

```python
from openai import OpenAI

client = OpenAI(
    api_key="agnic_tok_YOUR_TOKEN",
    base_url="https://api.agnic.ai/v1"
)

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

#### call implementation

use stream for real-time updates to user

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
  apiKey: 'agnic_tok_YOUR_TOKEN',
  baseURL: 'https://api.agnic.ai/v1'
});
const stream = await client.chat.completions.create({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Write a poem about JavaScript' }],
  stream: true
});
for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
```

stream chunk structure
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion.chunk",
  "model": "openai/gpt-4o",
  "choices": [{
    "index": 0,
    "delta": {
      "content": "Hello"
    },
    "finish_reason": null
  }]
}
```

Best Practices
Always handle partial responses - Streams can disconnect mid-response
Implement timeouts - Don't wait forever for chunks
Show loading state - Indicate when waiting for first chunk
Buffer for display - Some UI frameworks work better with small batches
Track usage - Final chunk may include token usage info

Use the following routes / rules to build out the application - key available in env vars for the project

1. to check balance:

```bash
curl https://api.agnic.ai/api/balance\?network\=base \
  -H "X-Agnic-Token: ${AGNIC_API_KEY}"
{"usdcBalance":"18.139474","address":"0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2","hasWallet":true,"network":"base","chainType":"ethereum","creditBalance":"49.9999","totalBalance":"68.139374"}% 
```

2. sample call to llm model with agnic interface
```bash
curl https://api.agnic.ai/v1/chat/completions \
  -H "X-Agnic-Token: ${AGNIC_API_KEY}" \    
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini", <- same model choices as open-router
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

```

sample response
```bash
{"id":"gen-1779358422-LrEwL8SmYSWNlAzrHKq2","object":"chat.completion","created":1779358422,"model":"openai/gpt-4o-mini","provider":"Azure","system_fingerprint":"fp_eb37e061ec","choices":[{"index":0,"logprobs":null,"finish_reason":"stop","native_finish_reason":"stop","message":{"role":"assistant","content":"Hello! How can I assist you today?","refusal":null,"reasoning":null}}],"usage":{"prompt_tokens":9,"completion_tokens":10,"total_tokens":19,"cost":0.00000735,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.00000735,"upstream_inference_prompt_cost":0.00000135,"upstream_inference_completions_cost":0.000006},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}},"agnic":{"request_id":"req_6cJzSPFcRIwstAHJ","cost_usd":"0.000100","latency_ms":1219}}
```


## Agent memory

After completing any feature work, update the project memory:

1. **Append one row** to `docs/agent-log.md`:
   `| YYYY-MM-DD | <slug> | <one-line summary of what was built> |`

2. **Create `docs/features/<slug>.md`** with:
   - **What:** one sentence on what the feature does
   - **Files:** paths of files added or changed
   - **Config:** env vars or external dependencies added
   - **Notes:** gotchas, known gaps, or follow-ups

Use the slug from the log row as the filename. Do this at the end of every feature implementation, before closing out the task.

## Planning rules

When writing plan tickets (Plan persona), every ticket must include:

- **Acceptance criteria** — the observable behavior that proves the ticket is done
- **Validation commands** — exact `deno check`, `deno lint`, `deno test` commands to run
- **Test spec** — named test cases / scenarios that must exist (not just "write tests")
