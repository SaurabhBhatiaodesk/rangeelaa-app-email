# One-shot Heroku bootstrap (run after account is verified)
# Usage: bash scripts/heroku-setup.sh YOUR_APP_NAME your-store.myshopify.com

set -euo pipefail

APP_NAME="${1:-rangeela-shipping-manager}"
SHOP="${2:?Usage: $0 <heroku-app-name> <shop.myshopify.com>}"

if ! heroku apps:info -a "$APP_NAME" >/dev/null 2>&1; then
  echo "Creating app $APP_NAME..."
  heroku create "$APP_NAME"
else
  echo "Using existing app $APP_NAME"
  heroku git:remote -a "$APP_NAME"
fi

heroku addons:create scheduler:standard -a "$APP_NAME" || true

# Set from local env if present
if [ -z "${KLAVIYO_API_KEY:-}" ]; then
  echo "Set KLAVIYO_API_KEY in your shell first"
  exit 1
fi

heroku config:set \
  KLAVIYO_API_KEY="$KLAVIYO_API_KEY" \
  CRON_SHOP="$SHOP" \
  CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 24)}" \
  KLAVIYO_THURSDAY_TEMPLATE_ID="${KLAVIYO_THURSDAY_TEMPLATE_ID:-}" \
  THURSDAY_WAIT_URL="${THURSDAY_WAIT_URL:-}" \
  -a "$APP_NAME"

echo "Done. Next:"
echo "  1. heroku config:set SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... SHOPIFY_APP_URL=https://$APP_NAME.herokuapp.com SCOPES=... -a $APP_NAME"
echo "  2. Connect GitHub auto-deploy in Heroku Dashboard"
echo "  3. Add Scheduler jobs from docs/operations.md"
echo "  4. shopify app deploy"
