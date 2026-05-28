use base64::Engine;
use serde_json::Value;

#[tauri::command]
pub async fn parse_references_grobid(pdf_path: String) -> Result<Value, String> {
    let pdf_bytes = std::fs::read(&pdf_path).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .part(
            "input",
            reqwest::multipart::Part::bytes(pdf_bytes)
                .file_name("paper.pdf")
                .mime_str("application/pdf")
                .unwrap(),
        );

    let resp = client
        .post("http://localhost:8070/api/processFulltextDocument")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("GROBID request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GROBID returned HTTP {}", resp.status()));
    }

    let xml = resp.text().await.map_err(|e| e.to_string())?;

    fn extract_between(text: &str, open: &str, close: &str) -> String {
        if let Some(start) = text.find(open) {
            let after = &text[start + open.len()..];
            if let Some(end) = after.find(close) {
                return after[..end].trim().to_string();
            }
        }
        String::new()
    }

    // Parse bibliography entries from <back> section only (skip header biblStruct)
    let mut refs = Vec::new();
    let back_section = extract_between(&xml, "<back>", "</back>");
    for (i, bib) in back_section.split("<biblStruct").skip(1).enumerate() {
        let xml_id = if let Some(id_start) = bib.find("xml:id=\"") {
            let after = &bib[id_start + 8..];
            if let Some(id_end) = after.find('"') {
                after[..id_end].to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let analytic = extract_between(bib, "<analytic>", "</analytic>");
        let monogr = extract_between(bib, "<monogr>", "</monogr>");

        let analytic_title = {
            let t =
                extract_between(&analytic, "<title level=\"a\" type=\"main\">", "</title>");
            if !t.is_empty() {
                t
            } else {
                let t2 = extract_between(&analytic, "<title", "</title>");
                if let Some(gt) = t2.find('>') {
                    t2[gt + 1..].to_string()
                } else {
                    String::new()
                }
            }
        };

        let has_analytic_title = !analytic_title.is_empty();
        let title = if has_analytic_title {
            analytic_title
        } else {
            let t = extract_between(&monogr, "<title level=\"m\" type=\"main\">", "</title>");
            if !t.is_empty() {
                t
            } else {
                let t2 = extract_between(&monogr, "<title", "</title>");
                if let Some(gt) = t2.find('>') {
                    t2[gt + 1..].to_string()
                } else {
                    String::new()
                }
            }
        };

        let venue = {
            let j = extract_between(&monogr, "<title level=\"j\">", "</title>");
            if !j.is_empty() {
                j
            } else if has_analytic_title {
                let m = extract_between(&monogr, "<title level=\"m\">", "</title>");
                if !m.is_empty() {
                    m
                } else {
                    extract_between(&monogr, "<meeting>", "</meeting>")
                }
            } else {
                extract_between(&monogr, "<meeting>", "</meeting>")
            }
        };

        let year = {
            if let Some(d_start) = bib.find("<date") {
                let date_tag = &bib[d_start..d_start + 100.min(bib.len() - d_start)];
                if let Some(w_start) = date_tag.find("when=\"") {
                    let after = &date_tag[w_start + 6..];
                    after.chars().take(4).collect::<String>()
                } else {
                    extract_between(date_tag, ">", "</date>")
                        .chars()
                        .filter(|c| c.is_ascii_digit())
                        .take(4)
                        .collect()
                }
            } else {
                String::new()
            }
        };

        let first_author = extract_between(bib, "<surname>", "</surname>");

        if !title.is_empty() {
            refs.push(serde_json::json!({
                "index": i + 1,
                "xmlId": xml_id,
                "title": title,
                "venue": venue,
                "year": year,
                "firstAuthor": first_author,
            }));
        }
    }

    // Parse inline citations from body
    let mut citations = Vec::new();
    let body = extract_between(&xml, "<body>", "</body>");
    for cite_chunk in body.split("<ref type=\"bibr\"").skip(1) {
        let target = if let Some(t_start) = cite_chunk.find("target=\"#") {
            let after = &cite_chunk[t_start + 9..];
            if let Some(t_end) = after.find('"') {
                after[..t_end].to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let text = if let Some(gt) = cite_chunk.find('>') {
            let after = &cite_chunk[gt + 1..];
            if let Some(end) = after.find("</ref>") {
                after[..end].trim().to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        if !text.is_empty() {
            citations.push(serde_json::json!({
                "text": text,
                "target": target,
            }));
        }
    }

    // Ternary classification: bracket [N], bracket-author [Author, Year], or parenthetical (Author, Year)
    let resolved: Vec<&str> = citations
        .iter()
        .filter(|c| !c["target"].as_str().unwrap_or("").is_empty())
        .take(10)
        .filter_map(|c| c["text"].as_str())
        .collect();

    let has_bracket_num = resolved.iter().any(|t| {
        t.contains('[') && t.chars().any(|ch| ch.is_ascii_digit()) && !t.chars().any(|ch| ch.is_alphabetic())
    });
    let has_bracket_author = resolved.iter().any(|t| {
        t.contains('[') && t.chars().any(|ch| ch.is_alphabetic()) && t.chars().any(|ch| ch.is_ascii_digit())
    });

    let style = if has_bracket_num {
        "bracket"
    } else if has_bracket_author {
        "bracket-author"
    } else {
        "parenthetical"
    };

    Ok(serde_json::json!({
        "style": style,
        "references": refs,
        "citations": citations,
    }))
}

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
        .query(&[("q", &query), ("format", &"json".to_string()), ("limit", &"1".to_string())])
        .header("User-Agent", "PDFReader/1.0")
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
