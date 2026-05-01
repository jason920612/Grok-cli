import OpenAI from "openai";

export function createXaiClient() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY. Set it with: export XAI_API_KEY='your_api_key'");
  }

  return new OpenAI({
    apiKey,
    baseURL: "https://api.x.ai/v1",
    timeout: 360_000
  });
}
