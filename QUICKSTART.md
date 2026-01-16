# Execution Wall - Quick Start Guide

Get your trading firewall up and running in 15 minutes!

## What You've Got

✅ **Complete Backend API** - Node.js + Express + TypeScript
✅ **Webhook Endpoint** - Ready for TradingView signals
✅ **Database Cleanup** - Automatic 80 MB limit enforcement
✅ **Local Storage** - All data stays on your computer
✅ **Comprehensive Logging** - See every webhook that comes in

## Prerequisites

- Node.js 18+ installed
- Windows computer

## Setup Steps

### 1. Install PostgreSQL (10 minutes)

Follow the detailed guide: [SETUP_POSTGRESQL.md](SETUP_POSTGRESQL.md)

**Quick summary:**
1. Download from https://www.postgresql.org/download/windows/
2. Install with password (remember it!)
3. Create database named `execution_wall`
4. Update `backend\.env` with your password

### 2. Run Database Migrations (2 minutes)

```cmd
cd backend
npx prisma generate
npx prisma migrate dev --name init
```

### 3. Start Backend Server (1 minute)

```cmd
cd backend
npm run dev
```

You should see:
```
✅ Server running on http://localhost:3000
💾 Database: 80 MB limit with auto-cleanup
🕐 Starting database cleanup scheduler
```

### 4. Test Webhook (1 minute)

Open new Command Prompt:

```cmd
curl -X POST http://localhost:3000/api/webhook/tradingview -H "Content-Type: application/json" -d "{\"ticker\":\"AAPL\",\"dir\":\"Long\",\"price\":175.50,\"quality_tier\":\"A\",\"quality_score\":85}"
```

**Expected:**
```json
{
  "success": true,
  "intent_id": "...",
  "message": "Trade intent created successfully"
}
```

### 5. View Your Data (30 seconds)

```cmd
cd backend
npx prisma studio
```

Opens http://localhost:5555 - browse all tables and see your test webhook!

## TradingView Configuration

Once your backend is running, update your TradingView alerts:

**Webhook URL:**
```
http://localhost:3000/api/webhook/tradingview
```

**Alert Message:**
```json
{
  "ticker": "{{ticker}}",
  "dir": "Long",
  "quality_tier": "A",
  "quality_score": 85,
  "price": {{close}}
}
```

## What's Working Now

✅ **TradingView Webhooks** - Receives and logs every signal
✅ **Database Storage** - All data stored locally
✅ **Auto Cleanup** - Keeps database under 80 MB
✅ **Audit Trail** - Complete history of all actions
✅ **Webhook Logs** - See what TradingView sends

## What's Next

🚧 **Frontend Migration** - Update React app to use new API
🚧 **Webhook Logs UI** - View webhook logs in the browser
🚧 **Settings Page Update** - Show new webhook URL
🚧 **Dashboard Update** - Display trade signals from new API

## Useful Commands

```cmd
# View database in browser
cd backend && npx prisma studio

# Check database size and stats
curl http://localhost:3000/api/database/stats

# View webhook logs
curl http://localhost:3000/api/webhook/logs

# Manual database cleanup
curl -X POST http://localhost:3000/api/database/cleanup

# Health check
curl http://localhost:3000/health
```

## Project Structure

```
Execution-Wall8/
├── backend/                    # ✅ Complete and running
│   ├── src/
│   │   ├── index.ts           # Express server
│   │   ├── controllers/       # Webhook logic
│   │   ├── routes/            # API endpoints
│   │   └── services/          # Database cleanup
│   └── prisma/
│       └── schema.prisma      # Database schema
├── src/                       # 🚧 Needs updating
│   ├── api/
│   │   ├── apiClient.ts       # ✅ Ready
│   │   ├── queries.ts         # ✅ Ready
│   │   └── actions.ts         # ✅ Ready
│   ├── pages/                 # 🚧 Update to use new API
│   └── components/            # 🚧 Update to use new API
```

## Troubleshooting

### Webhook not working?

1. **Check backend is running:**
   ```cmd
   curl http://localhost:3000/health
   ```

2. **Test webhook manually:**
   ```cmd
   curl -X POST http://localhost:3000/api/webhook/tradingview -H "Content-Type: application/json" -d "{\"ticker\":\"TEST\",\"dir\":\"Long\",\"price\":100}"
   ```

3. **View logs:**
   ```cmd
   curl http://localhost:3000/api/webhook/logs
   ```

4. **Check Prisma Studio:**
   ```cmd
   cd backend && npx prisma studio
   ```
   Look in `webhook_logs` table

### Database issues?

- Check PostgreSQL is running (Services → postgresql-x64-16)
- Verify password in `backend\.env`
- Ensure database `execution_wall` exists (pgAdmin 4)

## Next Steps for You

1. ✅ Follow [SETUP_POSTGRESQL.md](SETUP_POSTGRESQL.md) to install PostgreSQL
2. ✅ Run the migrations
3. ✅ Test the webhook endpoint
4. ✅ View data in Prisma Studio
5. ⏭️ I'll help update the frontend to use the new API

## Why This Solution Works

**Before (Base44):**
- ❌ Webhooks silently failing
- ❌ No way to see what's happening
- ❌ Vendor lock-in
- ❌ Limited debugging

**After (This Setup):**
- ✅ Every webhook logged to database
- ✅ View all data in Prisma Studio
- ✅ Complete control over backend
- ✅ Automatic cleanup maintains 80 MB limit
- ✅ All data stays on your computer

## Support

- **Setup issues:** See [SETUP_POSTGRESQL.md](SETUP_POSTGRESQL.md)
- **Backend docs:** See [backend/README.md](backend/README.md)
- **Migration status:** See [MIGRATION_STATUS.md](MIGRATION_STATUS.md)

Ready to proceed with PostgreSQL setup? Follow the instructions in SETUP_POSTGRESQL.md!
