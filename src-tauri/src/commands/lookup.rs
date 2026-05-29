use base64::Engine;
use serde_json::Value;


#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn proxy_image(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "PDFReader/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", content_type, b64))
}

#[tauri::command]
pub async fn geocode_location(query: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://nominatim.openstreetmap.org/search")
        .query(&[("q", &query), ("format", &"json".to_string()), ("limit", &"1".to_string()), ("accept-language", &"en".to_string())])
        .header("User-Agent", "PDFReader/1.0")
        .header("Accept-Language", "en")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let results: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(first) = results.into_iter().next() {
        Ok(serde_json::json!({
            "lat": first["lat"],
            "lon": first["lon"],
            "display_name": first["display_name"],
        }))
    } else {
        Err("Location not found".to_string())
    }
}

#[tauri::command]
pub async fn lookup_person(name: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Try OpenAlex first (researcher)
    if let Ok(result) = try_openalex(&client, &name).await {
        return Ok(result);
    }

    // Fall back to Wikipedia (historical figure)
    if let Ok(result) = try_wikipedia(&client, &name).await {
        return Ok(result);
    }

    Err("Person not found".to_string())
}

async fn try_openalex(client: &reqwest::Client, name: &str) -> Result<Value, String> {
    let resp = client
        .get("https://api.openalex.org/authors")
        .query(&[("search", name), ("per_page", "1")])
        .header("User-Agent", "PDFReader/1.0 (mailto:pdfreader@example.com)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data: Value = resp.json().await.map_err(|e| e.to_string())?;

    let results = data["results"].as_array().ok_or("No results")?;
    let author = results.first().ok_or("No author found")?;

    let works_count = author["works_count"].as_u64().unwrap_or(0);
    let cited_by = author["cited_by_count"].as_u64().unwrap_or(0);

    if works_count < 2 && cited_by < 5 {
        return Err("Not a significant researcher match".to_string());
    }

    let display_name = author["display_name"].as_str().unwrap_or("").to_string();

    let institution = author["last_known_institutions"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|inst| inst["display_name"].as_str())
        .unwrap_or("Unknown")
        .to_string();

    let country = author["last_known_institutions"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|inst| inst["country_code"].as_str())
        .unwrap_or("")
        .to_string();

    let topics: Vec<String> = author["topics"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(5)
                .filter_map(|t| t["display_name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let h_index = author["summary_stats"]["h_index"].as_u64().unwrap_or(0);

    let orcid = author["orcid"].as_str().unwrap_or("").to_string();
    let openalex_id = author["id"].as_str().unwrap_or("").to_string();

    Ok(serde_json::json!({
        "type": "researcher",
        "name": display_name,
        "institution": institution,
        "country": country,
        "works_count": works_count,
        "cited_by_count": cited_by,
        "h_index": h_index,
        "topics": topics,
        "orcid": orcid,
        "openalex_url": openalex_id,
    }))
}

async fn try_wikipedia(client: &reqwest::Client, name: &str) -> Result<Value, String> {
    let encoded = name.replace(' ', "_");
    let url = format!(
        "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
        encoded
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "PDFReader/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err("Wikipedia page not found".to_string());
    }

    let data: Value = resp.json().await.map_err(|e| e.to_string())?;

    let title = data["title"].as_str().unwrap_or("").to_string();
    let extract = data["extract"].as_str().unwrap_or("").to_string();
    let description = data["description"].as_str().unwrap_or("").to_string();
    let thumbnail = data["thumbnail"]["source"].as_str().unwrap_or("").to_string();
    let page_url = data["content_urls"]["desktop"]["page"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if extract.is_empty() {
        return Err("No Wikipedia content found".to_string());
    }

    Ok(serde_json::json!({
        "type": "historical",
        "name": title,
        "description": description,
        "extract": extract,
        "thumbnail": thumbnail,
        "url": page_url,
    }))
}

#[tauri::command]
pub async fn resolve_citation(query: String, query_type: String, api_key: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let fields = "title,authors,year,venue,abstract,citationCount,externalIds,isOpenAccess,openAccessPdf,url";

    let paper: Value = if query_type == "doi" {
        let url = format!(
            "https://api.semanticscholar.org/graph/v1/paper/DOI:{}?fields={}",
            query, fields
        );
        let resp = client
            .get(&url)
            .header("x-api-key", &api_key)
            .header("User-Agent", "PDFReader/1.0")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Semantic Scholar DOI lookup failed: {}", resp.status()));
        }
        resp.json().await.map_err(|e| e.to_string())?
    } else {
        let url = "https://api.semanticscholar.org/graph/v1/paper/search";
        let resp = client
            .get(url)
            .query(&[("query", query.as_str()), ("fields", fields), ("limit", "1")])
            .header("x-api-key", &api_key)
            .header("User-Agent", "PDFReader/1.0")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Semantic Scholar search failed: {}", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| e.to_string())?;
        let results = data["data"].as_array().ok_or("No results")?;
        results.first().ok_or("No papers found")?.clone()
    };

    let title = paper["title"].as_str().unwrap_or("Unknown");
    let year = paper["year"].as_u64().unwrap_or(0);
    let venue = paper["venue"].as_str().unwrap_or("");
    let abstract_text = paper["abstract"].as_str().unwrap_or("");
    let citation_count = paper["citationCount"].as_u64().unwrap_or(0);
    let s2_url = paper["url"].as_str().unwrap_or("");

    let authors: Vec<String> = paper["authors"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let doi = paper["externalIds"]["DOI"].as_str().unwrap_or("").to_string();
    let arxiv_id = paper["externalIds"]["ArXiv"].as_str().unwrap_or("").to_string();

    let open_access_url = paper["openAccessPdf"]["url"].as_str().unwrap_or("").to_string();

    // Build PDF links: only use verified open access URLs, not DOI landing pages
    let venue_pdf = if !open_access_url.is_empty() && !open_access_url.contains("arxiv") {
        open_access_url.clone()
    } else {
        String::new()
    };

    let arxiv_pdf = if !arxiv_id.is_empty() {
        format!("https://arxiv.org/pdf/{}", arxiv_id)
    } else if open_access_url.contains("arxiv") {
        open_access_url.clone()
    } else {
        String::new()
    };

    Ok(serde_json::json!({
        "title": title,
        "authors": authors,
        "year": year,
        "venue": venue,
        "abstract": abstract_text,
        "citation_count": citation_count,
        "doi": doi,
        "arxiv_id": arxiv_id,
        "venue_pdf": venue_pdf,
        "arxiv_pdf": arxiv_pdf,
        "s2_url": s2_url,
    }))
}

#[tauri::command]
pub async fn search_arxiv(title: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let query = title.replace('"', "").replace('&', "and");
    let url = format!(
        "http://export.arxiv.org/api/query?search_query=ti:\"{}\"&max_results=1",
        query
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "PDFReader/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body = resp.text().await.map_err(|e| e.to_string())?;

    // Parse arXiv ID from XML response
    // Look for <id>http://arxiv.org/abs/XXXX.XXXXX</id>
    if let Some(start) = body.find("arxiv.org/abs/") {
        let rest = &body[start + 14..];
        if let Some(end) = rest.find('<') {
            let arxiv_id = rest[..end].trim_end_matches(|c: char| c == 'v' || c.is_ascii_digit());
            let arxiv_id = arxiv_id.trim_end_matches('v');
            // Get clean ID
            let id = rest[..end].split('v').next().unwrap_or(&rest[..end]);
            if !id.is_empty() {
                return Ok(format!("https://arxiv.org/pdf/{}", id));
            }
        }
    }

    Err("Not found on arXiv".to_string())
}

#[tauri::command]
pub async fn download_pdf(url: String, folder: String, filename: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .connect_timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("User-Agent", "PDFReader/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    if bytes.len() < 100 {
        return Err("Response too small to be a PDF".to_string());
    }

    if !bytes.starts_with(b"%PDF") && !content_type.contains("pdf") && !content_type.contains("octet-stream") {
        return Err(format!("Not a PDF (content-type: {})", content_type));
    }

    let safe_name: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ' ' || c == '[' || c == ']' { c } else { '_' })
        .collect();
    let path = std::path::Path::new(&folder).join(&safe_name);

    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}
