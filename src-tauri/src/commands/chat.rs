use reqwest::Client;
use serde_json::{json, Value};

#[tauri::command]
pub async fn send_chat_message(
    messages: Vec<Value>,
    model: String,
    api_url: String,
    api_key: String,
) -> Result<String, String> {
    let client = Client::new();

    let url = format!("{}/chat/completions", api_url.trim_end_matches('/'));

    let body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": 16384,
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    if !status.is_success() {
        return Err(format!("API error ({}): {}", status, body));
    }

    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No content in response".to_string())
}
