# Example Agent

The example agent for [Welt](https://github.com/iwamot/welt): the smallest complete agent that exercises the wire in both directions through @welt-io/openai-agents.

## Stack

| Package | Role |
|---------|------|
| [Bedrock AgentCore SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript) | Serves the endpoint |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | Runs the model and the tools (`run` with `stream: true`) |
| @welt-io/openai-agents | Adapts the wire to Welt |

The model runs on Amazon Bedrock through the OpenAI-compatible [`bedrock-mantle` endpoint](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html) — the SDK's OpenAI provider gets a different base URL and a Bedrock API key, and no OpenAI account is involved. The provider is set to the Chat Completions API rather than the Responses API: this SDK sends assistant history to the Responses API as output items, a form the endpoint's validation rejects, so every turn after the first would fail there. A model this endpoint serves only through the Responses API (the Anthropic models, for one) is therefore out of reach for this example — it refuses the chat API outright, and the Responses path breaks on the second turn. To run against another OpenAI-compatible service instead, change the base URL in `main.ts` and the key it is paired with.

## Run Locally

The agent runs on your machine as-is — the AgentCore SDK serves the same HTTP surface locally, on port 8080, that AgentCore Runtime serves in the cloud, and [Welt's local mode](https://github.com/iwamot/welt#quick-start) invokes it there.

Generate a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) in the Amazon Bedrock console, then fetch the agent and run it with Node.js 24, which runs TypeScript directly:

```sh
curl -O https://raw.githubusercontent.com/iwamot/welt-io-openai-agents-ts/main/examples/agent/src/main.ts
echo '{"type":"module"}' > package.json
npm install @welt-io/openai-agents @openai/agents zod bedrock-agentcore
AWS_BEARER_TOKEN_BEDROCK="<your Bedrock API key>" node main.ts
```

The endpoint's region comes from `AWS_REGION` / `AWS_DEFAULT_REGION`, falling back to `us-east-1`. `MODEL_ID` takes any model the account may invoke on the endpoint's `/v1/models` listing; unset, the agent uses `openai.gpt-oss-120b`.

One difference from the cloud: AgentCore Runtime gives every session its own microVM, while the local server is a single process for all sessions — the agent stashes an interrupted run in one slot, so keep approval experiments to one thread at a time.

## Deploy

Deploy with the [AgentCore CLI](https://github.com/aws/agentcore-cli), replacing the generated agent with this one — the CLI's only TypeScript template is the Strands one, so that is the scaffold, and the agent inside it is swapped:

```sh
agentcore create --name WeltExample --no-agent
cd WeltExample
agentcore add agent --name WeltExample --type create --build CodeZip --language TypeScript --framework Strands --model-provider Bedrock --memory none

curl -o app/WeltExample/main.ts https://raw.githubusercontent.com/iwamot/welt-io-openai-agents-ts/main/examples/agent/src/main.ts
npm --prefix app/WeltExample install @welt-io/openai-agents @openai/agents zod
npm --prefix app/WeltExample uninstall @strands-agents/sdk

agentcore deploy
```

The Strands template assumes AWS credentials for the model; this agent talks to Bedrock's OpenAI-compatible endpoint instead, so what the deployed runtime needs in its environment is `AWS_BEARER_TOKEN_BEDROCK` — a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) — plus `MODEL_ID` for a model other than the default `openai.gpt-oss-120b`. Note the agent runtime ARN from the deploy output: Welt's `AGENT_ARN` points at it.

## Tools

- `current_time` — the minimal tool: plain text streaming, nothing else. Ask "what time is it?" to see tool use in the thread.
- `create_sample_file` — writes a small CSV that Welt uploads to the thread. The Bedrock endpoint takes a tool's output only as a string — the file content parts the OpenAI platform accepts are rejected — so the tool queues the file and the entrypoint yields it as a `file` event itself, beside the tool's result. The result string carries the file's exact content, that being the one channel this endpoint gives the model: without it, the model describes the upload by making one up. Ask it for a sample file.
- `sample_draft_report` — the model drafts a report and passes it as an argument, so the approval question shows the draft itself, and an approved call publishes exactly what was shown (the SDK resumes it with the arguments it was approved with). The published draft reaches the thread as a markdown file. Ask for two reports on different topics to see several questions pend and resolve in one round trip.
- `sample_dangerous_action` — a pretend dangerous action (no side effects, no extra AWS permissions) gated by `needsApproval: true`: the tool itself carries no approval code, and the run pauses before its body starts. Welt renders **Approve** / **Reject** buttons in the Slack thread, and the pressed one decides whether the tool runs. Ask "deploy to prod", then press a button. See [Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) for the round trip.

The adapter's `filesFrom` is not used here: it takes files from tool outputs, which is a shape this stack's endpoint refuses — see `create_sample_file` above. Against an endpoint that accepts file content in tool outputs, naming the tool in `filesFrom` replaces the queue-and-yield pattern.

## Optional: file input

The agent can also read files uploaded to Slack — disabled by default, and it needs a model with vision / file input (the default `openai.gpt-oss-120b` is text-only). To try it, point `MODEL_ID` at a model that reads images or documents and set in Welt's `.env`:

```sh
FILE_INPUT_MODALITIES=image,document
```

`video` is not supported: the SDK has no video input, so the adapter refuses video blocks outright — see [Welt's Files doc](https://github.com/iwamot/welt/blob/main/docs/files.md) for the Welt side.
