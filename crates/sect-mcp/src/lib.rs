//! `sect-mcp`: the seven verbs as MCP tools (spec B.3), served over stdio by default or over
//! loopback HTTP. Tool parameters are the `sect-verbs` argument structs, so the schemas an agent
//! sees are the CLI's definitions. The admin verbs (`sect_index`, `sect_rebuild`) exist only
//! when the server is started with the full toolset.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, ErrorData, Implementation, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
use sect_core::{Refresh, SectError};
use sect_index::Index;
use sect_verbs::{
    DefineArgs, GrepArgs, IndexArgs, MapArgs, Outcome, ReadArgs, RebuildArgs, RefsArgs, SearchArgs,
    StatusArgs,
};

pub const INSTRUCTIONS: &str = "sect answers questions about a structured corpus of rules. Every answer starts with a freshness line and a counts line; read them. Use sect_search for questions in prose (citations and defined terms are resolved structurally first), sect_grep for exact strings or regexes, sect_read to see a section (with as_of for the text in force on a date), sect_refs for what points at a section or what it cites, sect_define for defined terms, sect_map for the table of contents under a scope, sect_status for what the corpus contains. Ranking never guarantees completeness: for a complete list use sect_map with complete=true, sect_refs, or sect_grep.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toolset {
    /// The seven verbs.
    Seven,
    /// The seven verbs plus `sect_index` and `sect_rebuild`.
    Full,
}

impl Toolset {
    pub fn parse(s: &str) -> Option<Toolset> {
        match s {
            "seven" | "default" | "query" => Some(Toolset::Seven),
            "full" | "admin" => Some(Toolset::Full),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct SectServer {
    corpus: PathBuf,
    refresh: Refresh,
    include_superseded: bool,
    tool_router: ToolRouter<Self>,
}

fn to_result(o: Outcome) -> CallToolResult {
    let mut r = CallToolResult::success(vec![ContentBlock::text(o.text)]);
    r.structured_content = Some(o.json);
    r
}

impl SectServer {
    pub fn new(
        corpus: PathBuf,
        refresh: Refresh,
        include_superseded: bool,
        toolset: Toolset,
    ) -> Self {
        let mut tool_router = Self::seven_router();
        if toolset == Toolset::Full {
            tool_router += Self::admin_router();
        }
        Self {
            corpus,
            refresh,
            include_superseded,
            tool_router,
        }
    }

    /// The tools this server advertises, in router order.
    pub fn tools(&self) -> Vec<Tool> {
        self.tool_router.list_all()
    }

    /// Run a verb on a blocking thread: the index is opened under the freshness policy on every
    /// call (spec B.6: every query stats the tree), and a verb error becomes a tool error result
    /// rather than a protocol error, so the agent sees the message.
    async fn call<A, F>(&self, args: A, f: F) -> Result<CallToolResult, ErrorData>
    where
        A: Send + 'static,
        F: FnOnce(&Index, A) -> sect_core::Result<Outcome> + Send + 'static,
    {
        let (corpus, refresh) = (self.corpus.clone(), self.refresh);
        let r = tokio::task::spawn_blocking(move || {
            let index = sect_verbs::open(&corpus, refresh)?;
            f(&index, args)
        })
        .await
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(match r {
            Ok(o) => to_result(o),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("error: {e}"))]),
        })
    }

    async fn call_build<A, F>(&self, args: A, f: F) -> Result<CallToolResult, ErrorData>
    where
        A: Send + 'static,
        F: FnOnce(&std::path::Path, A) -> sect_core::Result<Outcome> + Send + 'static,
    {
        let corpus = self.corpus.clone();
        let r = tokio::task::spawn_blocking(move || f(&corpus, args))
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(match r {
            Ok(o) => to_result(o),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("error: {e}"))]),
        })
    }
}

// Descriptions are literals here because the attribute takes literals only; the unit test below
// checks each one against the constant in `sect-verbs`, so the two cannot drift.
#[tool_router(router = seven_router, vis = "pub")]
impl SectServer {
    #[tool(
        name = "sect_search",
        description = "Ranked hybrid retrieval over the corpus: BM25 and embeddings fused with RRF, up to 50 distinct passages with source evidence and bounded context. A citation (\"99 CFR 2.8\") or a definition question (\"what is a hole\") is answered structurally first. Start here for any question in prose."
    )]
    async fn search(
        &self,
        Parameters(a): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let inc = self.include_superseded;
        self.call(a, move |i, a| sect_verbs::search(i, &a, inc))
            .await
    }

    #[tool(
        name = "sect_grep",
        description = "Exhaustive exact or regex search with ripgrep-compatible flags and path:line:text output, bounded by max_hits; beyond the bound the answer is per-file counts."
    )]
    async fn grep(&self, Parameters(a): Parameters<GrepArgs>) -> Result<CallToolResult, ErrorData> {
        self.call(a, |i, a| sect_verbs::grep(i, &a)).await
    }

    #[tool(
        name = "sect_read",
        description = "Show a section by Work id, Expression id, or id#anchor, or expand a search passage address into its complete canonical sections. Passage reads retain exact revisions; --as-of on a Work snaps to the text in force on a date, --history lists every version and the Actions between them."
    )]
    async fn read(&self, Parameters(a): Parameters<ReadArgs>) -> Result<CallToolResult, ErrorData> {
        let inc = self.include_superseded;
        self.call(a, move |i, a| sect_verbs::read(i, &a, inc)).await
    }

    #[tool(
        name = "sect_refs",
        description = "Cross-reference and amendment traversal: what points at this section, what it points to, filtered by edge type (references, overrides, narrows, supersedes, amends, defines)."
    )]
    async fn refs(&self, Parameters(a): Parameters<RefsArgs>) -> Result<CallToolResult, ErrorData> {
        let inc = self.include_superseded;
        self.call(a, move |i, a| sect_verbs::refs(i, &a, inc)).await
    }

    #[tool(
        name = "sect_define",
        description = "Defined-term lookup by structural resolution: the defining section and paragraph, optionally the sections that use the term."
    )]
    async fn define(
        &self,
        Parameters(a): Parameters<DefineArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call(a, |i, a| sect_verbs::define(i, &a)).await
    }

    #[tool(
        name = "sect_map",
        description = "Table of contents under a scope, bounded by a token budget; complete=true returns the whole subtree by traversal (sections under a container, paragraphs under a section)."
    )]
    async fn map(&self, Parameters(a): Parameters<MapArgs>) -> Result<CallToolResult, ErrorData> {
        self.call(a, |i, a| sect_verbs::map(i, &a)).await
    }

    #[tool(
        name = "sect_status",
        description = "Freshness, counts, warnings, unresolved references, and the legal-status summary of the corpus."
    )]
    async fn status(
        &self,
        Parameters(a): Parameters<StatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call(a, |i, _a| sect_verbs::status(i)).await
    }
}

#[tool_router(router = admin_router, vis = "pub")]
impl SectServer {
    #[tool(
        name = "sect_index",
        description = "Admin: build or refresh the index (incremental; validate_only checks the B.2 contract and writes nothing)."
    )]
    async fn index(
        &self,
        Parameters(a): Parameters<IndexArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call_build(a, |c, a| sect_verbs::index(c, &a)).await
    }

    #[tool(
        name = "sect_rebuild",
        description = "Admin: rebuild every index layer from scratch, ignoring stored fingerprints."
    )]
    async fn rebuild(
        &self,
        Parameters(a): Parameters<RebuildArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call_build(a, |c, a| sect_verbs::rebuild(c, &a)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SectServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sect", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

/// Serve over stdin/stdout (the default transport). Nothing else may write to stdout.
pub async fn serve_stdio(server: SectServer) -> sect_core::Result<()> {
    let running = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| SectError::Other(format!("mcp: {e}")))?;
    running
        .waiting()
        .await
        .map_err(|e| SectError::Other(format!("mcp: {e}")))?;
    Ok(())
}

/// Serve MCP over streamable HTTP at `http://<addr>/mcp`. Loopback addresses only (spec B.3:
/// no auth beyond loopback), so anything else is refused before binding.
pub async fn serve_http(server: SectServer, addr: SocketAddr) -> sect_core::Result<()> {
    if !addr.ip().is_loopback() {
        return Err(SectError::Other(format!(
            "refusing to bind {addr}: the HTTP transport is loopback only (127.0.0.1 or ::1)"
        )));
    }
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| SectError::Other(format!("bind {addr}: {e}")))?;
    eprintln!("sect-mcp listening on http://{addr}/mcp (loopback only)");
    axum::serve(listener, router)
        .await
        .map_err(|e| SectError::Other(format!("http: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolsets_expose_the_seven_verbs_and_admin_only_when_asked() {
        let seven = SectServer::new(PathBuf::from("."), Refresh::Auto, false, Toolset::Seven);
        let names: Vec<String> = seven.tools().iter().map(|t| t.name.to_string()).collect();
        let want: Vec<&str> = sect_verbs::TOOLS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        let mut want_sorted = want.clone();
        want_sorted.sort();
        assert_eq!(sorted, want_sorted);
        for t in seven.tools() {
            let desc = sect_verbs::TOOLS
                .iter()
                .chain(sect_verbs::ADMIN_TOOLS.iter())
                .find(|(n, _)| *n == t.name.as_ref())
                .map(|(_, d)| *d)
                .unwrap();
            assert_eq!(
                t.description.as_deref(),
                Some(desc),
                "description of {} comes from sect-verbs",
                t.name
            );
        }
        let search = seven
            .tools()
            .into_iter()
            .find(|t| t.name == "sect_search")
            .unwrap();
        let schema = serde_json::to_value(&search.input_schema).unwrap();
        assert_eq!(schema["required"], serde_json::json!(["query"]), "{schema}");
        assert!(schema["properties"]["as_of"].is_object());
        let full = SectServer::new(PathBuf::from("."), Refresh::Auto, false, Toolset::Full);
        let names: Vec<String> = full.tools().iter().map(|t| t.name.to_string()).collect();
        assert_eq!(names.len(), 9);
        assert!(
            names.contains(&"sect_index".to_string())
                && names.contains(&"sect_rebuild".to_string())
        );
        assert_eq!(Toolset::parse("full"), Some(Toolset::Full));
        assert_eq!(Toolset::parse("seven"), Some(Toolset::Seven));
    }

    #[tokio::test]
    async fn http_refuses_non_loopback_addresses() {
        let server = SectServer::new(PathBuf::from("."), Refresh::Auto, false, Toolset::Seven);
        let err = serve_http(server, "0.0.0.0:7999".parse().unwrap())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("loopback"), "{err}");
    }
}
