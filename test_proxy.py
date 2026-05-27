from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8317/v1",
    api_key="123",
)

models_to_test = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
]

for model in models_to_test:
    print(f"\n{'='*60}")
    print(f"Model: {model}")
    print(f"{'='*60}")
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Say hello in one sentence."}],
            max_tokens=100,
        )
        print(f"Response: {response.choices[0].message.content}")
        print(f"Usage: {response.usage.prompt_tokens} prompt / {response.usage.completion_tokens} completion")
    except Exception as e:
        print(f"Error: {e}")
