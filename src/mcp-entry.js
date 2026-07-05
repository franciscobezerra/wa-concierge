const { startMcpServer } = require('./mcp/server');
const db = require('./db/database');

function parseArgs() {
  const args = process.argv.slice(2);
  const accounts = [];
  let profileId = null;
  let apiKey = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--account' || args[i] === '-a') && args[i + 1]) {
      accounts.push(args[i + 1]);
      i++;
    } else if ((args[i] === '--profile' || args[i] === '-p') && args[i + 1]) {
      profileId = args[i + 1];
      i++;
    } else if ((args[i] === '--key' || args[i] === '-k') && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    }
  }

  if (!apiKey && !profileId && accounts.length === 0) {
    console.error('[MCP] ERROR: Authentication required. Use --key <api_key>, --profile <id>, or --account <id>');
    console.error('[MCP] Create an AI profile in the dashboard (http://localhost:3000) to get an API key.');
    process.exit(1);
  }

  // Priority: --key > --profile > --account
  if (apiKey) {
    const profile = db.getAiProfileByApiKey(apiKey);
    if (!profile) {
      console.error('[MCP] ERROR: Invalid API key');
      process.exit(1);
    }
    return { allowedAccounts: profile.allowed_accounts.length > 0 ? profile.allowed_accounts : [], profileName: profile.name };
  }

  if (profileId) {
    const profile = db.getAiProfile(profileId);
    if (!profile) {
      console.error(`[MCP] ERROR: Profile "${profileId}" not found`);
      process.exit(1);
    }
    return { allowedAccounts: profile.allowed_accounts.length > 0 ? profile.allowed_accounts : [], profileName: profile.name };
  }

  return { allowedAccounts: accounts, profileName: null };
}

async function main() {
  const { allowedAccounts, profileName } = parseArgs();

  if (profileName) {
    console.error(`[MCP] Using profile "${profileName}" (restricted to: ${allowedAccounts.join(', ') || 'none'})`);
  } else if (allowedAccounts) {
    console.error(`[MCP] Restricted to accounts: ${allowedAccounts.join(', ')}`);
  } else {
    console.error('[MCP] No account filter — all accounts accessible');
  }

  // NOTE: MCP no longer auto-connects WhatsApp accounts.
  // The web dashboard (npm start) manages all connections.
  // MCP reads from the shared database and sends via the web server API.

  // Start MCP server with account restriction
  await startMcpServer(allowedAccounts);
}

main().catch(err => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
