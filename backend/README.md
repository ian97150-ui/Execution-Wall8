# Execution Wall Backend API

Node.js + Express + TypeScript + PostgreSQL backend for the Execution Wall trading application.

## Features

- TradingView webhook endpoint with comprehensive logging
- Zapier integration
- Trade intent management
- Execution queue processing
- Position tracking
- Audit logging
- JWT authentication
- RESTful API

## Prerequisites

- Node.js 18+ and npm
- PostgreSQL database

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and update the values:

```bash
cp .env.example .env
```

**Required environment variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT token generation
- `FRONTEND_URL` - Frontend application URL (for CORS)

### 3. Setup PostgreSQL Database

#### Option A: Local PostgreSQL

Install PostgreSQL locally and create a database:

```sql
CREATE DATABASE execution_wall;
```

Update `DATABASE_URL` in `.env`:
```
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/execution_wall?schema=public"
```

#### Option B: Cloud PostgreSQL (Railway, Supabase, Neon)

1. Create a PostgreSQL database on your preferred platform
2. Copy the connection string
3. Update `DATABASE_URL` in `.env`

### 4. Run Database Migrations

Generate Prisma client and create database tables:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

### 5. Start Development Server

```bash
npm run dev
```

The server will start on `http://localhost:3000`

## API Endpoints

### Webhook Endpoints (Public)

- `POST /api/webhook/tradingview` - TradingView webhook
- `POST /api/webhook/zapier` - Zapier webhook
- `GET /api/webhook/logs` - View webhook logs
- `POST /api/webhook/test` - Test webhook endpoint

### Trade Intents

- `GET /api/trade-intents` - Get all trade intents (with filters)
- `GET /api/trade-intents/:id` - Get single trade intent
- `POST /api/trade-intents/:id/swipe` - Swipe action (approve/deny/off)
- `POST /api/trade-intents/:id/invalidate` - Invalidate intent

### Executions

- `GET /api/executions` - Get all executions
- `POST /api/executions` - Create execution
- `POST /api/executions/:id/execute` - Force execute
- `POST /api/executions/:id/cancel` - Cancel execution

### Positions

- `GET /api/positions` - Get all positions
- `GET /api/positions/:id` - Get single position
- `POST /api/positions/:id/mark-flat` - Close position

### Settings

- `GET /api/settings` - Get execution settings
- `PUT /api/settings` - Update settings

### Ticker Configs

- `GET /api/ticker-configs` - Get all ticker configs
- `GET /api/ticker-configs/:ticker` - Get single ticker config
- `PUT /api/ticker-configs/:ticker` - Update ticker config

### Audit Logs

- `GET /api/audit-logs` - Get audit logs (with filters)

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

## TradingView Webhook Configuration

### Webhook URL

```
http://localhost:3000/api/webhook/tradingview
```

(In production, use your deployed domain)

### Alert Message Format

```json
{
  "ticker": "{{ticker}}",
  "dir": "Long",
  "quality_tier": "A+",
  "quality_score": 95,
  "price": {{close}},
  "card_state": "ARMED"
}
```

### Example TradingView Alert

**Condition:** Your signal condition (e.g., RSI crosses above 70)

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

**Webhook URL:** `http://your-domain.com/api/webhook/tradingview`

## Testing

### Test Webhook Locally

```bash
curl -X POST http://localhost:3000/api/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "AAPL",
    "dir": "Long",
    "quality_tier": "A+",
    "quality_score": 95,
    "price": 175.50
  }'
```

Expected response:
```json
{
  "success": true,
  "intent_id": "uuid-here",
  "message": "Trade intent created successfully"
}
```

### View Webhook Logs

```bash
curl http://localhost:3000/api/webhook/logs
```

## Database Management

### View Database in Prisma Studio

```bash
npm run prisma:studio
```

Opens a web interface at `http://localhost:5555` to view and edit database records.

### Create New Migration

After modifying `prisma/schema.prisma`:

```bash
npx prisma migrate dev --name your_migration_name
```

### Reset Database

```bash
npx prisma migrate reset
```

## Production Deployment

### Environment Variables

Set these in your deployment platform:

```env
DATABASE_URL=your_production_database_url
JWT_SECRET=your_strong_secret_key
PORT=3000
NODE_ENV=production
FRONTEND_URL=https://your-frontend-domain.com
```

### Build and Start

```bash
npm run build
npm start
```

## Troubleshooting

### Database Connection Issues

1. Check `DATABASE_URL` format is correct
2. Ensure PostgreSQL is running
3. Verify database user has correct permissions
4. Test connection: `npx prisma db pull`

### Webhook Not Receiving Data

1. Check webhook logs: `GET /api/webhook/logs`
2. Verify TradingView alert message format
3. Test with curl command (see Testing section)
4. Check CORS settings in `src/index.ts`

### Prisma Client Errors

Regenerate Prisma client:
```bash
npx prisma generate
```

## Development Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Language:** TypeScript
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Authentication:** JWT + bcrypt
- **Security:** Helmet, CORS
- **Validation:** express-validator

## License

MIT
