# LiteLLM price snapshot

`litellmPrices.json` is a trimmed snapshot of LiteLLM's `model_prices_and_context_window.json`
(https://github.com/BerriAI/litellm), used only to suggest list prices for Connection models
(`listPriceSuggestion.ts`). Suggestions are a starting point; the administrator confirms every price.

- Source commit: 4fa8bf1ff5515e2cb98908c62ba84c87ef938620
- Snapshot date: 2026-10-24
- Kept: entries whose `litellm_provider` is `openai`, `azure`, `anthropic`, `bedrock` or `bedrock_converse`
  and whose `mode` is `chat` or `embedding`; only the fields `input_cost_per_token`,
  `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`,
  `litellm_provider` and `mode`; keys sorted, 2-space JSON.

The file is `{ "_notice": <copyright line, source, commit and the MIT text below>, "prices": { … } }`: the notice travels
with the data into the image's dist (this .md does not). `NOTICE` in the command is that string.

Command (run once from this directory, `$SRC` = the source file):

```
node -e '
const s=require(process.argv[1]);const P=["openai","azure","anthropic","bedrock","bedrock_converse"],M=["chat","embedding"];
const K=["input_cost_per_token","output_cost_per_token","cache_read_input_token_cost","cache_creation_input_token_cost","litellm_provider","mode"];
const o={};for(const k of Object.keys(s).sort()){const e=s[k];if(!e||typeof e!=="object"||!P.includes(e.litellm_provider)||!M.includes(e.mode))continue;const r={};for(const f of [...K].sort())if(e[f]!==undefined)r[f]=e[f];o[k]=r;}
require("fs").writeFileSync("litellmPrices.json",JSON.stringify({_notice:NOTICE,prices:o},null,2)+"\n")' $SRC
```

## License (MIT, the part of the LiteLLM repository outside `enterprise/`)

MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
