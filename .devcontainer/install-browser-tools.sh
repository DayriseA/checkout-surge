#!/usr/bin/env bash
set -euo pipefail

playwright_cli_version="${CHECKOUT_SURGE_PLAYWRIGHT_CLI_VERSION:-latest}"
playwright_mcp_version="${CHECKOUT_SURGE_PLAYWRIGHT_MCP_VERSION:-latest}"
playwright_cli_smoke_session="checkout-surge-post-create-smoke"

close_playwright_cli_smoke_session() {
  playwright-cli -s="$playwright_cli_smoke_session" close >/dev/null 2>&1 || true
}

verify_playwright_cli() {
  local browser_snapshot

  trap close_playwright_cli_smoke_session EXIT
  playwright-cli -s="$playwright_cli_smoke_session" open \
    "data:text/html,<title>checkout-surge browser smoke</title><h1>Browser automation ready</h1>"
  browser_snapshot="$(
    playwright-cli -s="$playwright_cli_smoke_session" find "Browser automation ready"
  )"
  if ! rg -Fq 'heading "Browser automation ready"' <<<"$browser_snapshot"; then
    echo "Playwright CLI did not find the expected rendered heading." >&2
    return 1
  fi

  echo "Playwright CLI $(playwright-cli --version) controlled headless Chromium successfully."
  close_playwright_cli_smoke_session
  trap - EXIT
}

verify_playwright_mcp_chromium() {
  local global_node_modules
  local mcp_node_modules

  global_node_modules="$(npm root --global)"
  mcp_node_modules="${global_node_modules}/@playwright/mcp/node_modules"

  NODE_PATH="$mcp_node_modules" node <<'NODE'
const { chromium } = require("playwright-core");

async function verifyChromiumLaunch() {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>checkout-surge MCP smoke</title>");
    if ((await page.title()) !== "checkout-surge MCP smoke") {
      throw new Error("Chromium returned an unexpected page title");
    }
  } finally {
    await browser.close();
  }

  console.log(
    `Playwright MCP ${process.env.CHECKOUT_SURGE_PLAYWRIGHT_MCP_VERSION} launched sandboxed headless Chromium successfully.`,
  );
}

verifyChromiumLaunch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
}

npm install --global \
  "@playwright/cli@${playwright_cli_version}" \
  "@playwright/mcp@${playwright_mcp_version}"

# The CLI and MCP can require different Chromium revisions. Invoke both installers
# so neither interface depends on a best-effort cross-version match.
playwright-cli install-browser --with-deps chromium
playwright-mcp install-browser chromium

verify_playwright_cli
CHECKOUT_SURGE_PLAYWRIGHT_MCP_VERSION="$(playwright-mcp --version)" \
  verify_playwright_mcp_chromium
