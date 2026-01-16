# Local PostgreSQL Setup Guide for Windows

This guide will help you install PostgreSQL locally on your computer and set up the Execution Wall database.

## Step 1: Download PostgreSQL

1. Go to: https://www.postgresql.org/download/windows/
2. Click "Download the installer"
3. Download the latest version (16.x recommended)
4. File size: ~250 MB

## Step 2: Install PostgreSQL

1. **Run the installer** (postgresql-16.x-windows-x64.exe)

2. **Installation wizard:**
   - Installation Directory: `C:\Program Files\PostgreSQL\16` (default is fine)
   - Select Components: Check all (PostgreSQL Server, pgAdmin 4, Command Line Tools)
   - Data Directory: `C:\Program Files\PostgreSQL\16\data` (default is fine)

3. **Set Password:**
   - Choose a password for the PostgreSQL superuser (postgres)
   - **IMPORTANT:** Remember this password! You'll need it later
   - Example: `postgres123` (for local development)

4. **Port:**
   - Leave as default: `5432`

5. **Locale:**
   - Leave as default (English, United States)

6. **Complete Installation:**
   - Click "Next" through the remaining screens
   - Uncheck "Launch Stack Builder" at the end
   - Click "Finish"

## Step 3: Verify Installation

1. **Open Command Prompt** (Win + R, type `cmd`)

2. **Check PostgreSQL is running:**
   ```cmd
   psql --version
   ```
   Should show: `psql (PostgreSQL) 16.x`

If command not found, add PostgreSQL to PATH:
- Add `C:\Program Files\PostgreSQL\16\bin` to your system PATH
- Restart Command Prompt

## Step 4: Create Database

1. **Open pgAdmin 4** (Start Menu → PostgreSQL 16 → pgAdmin 4)

2. **Connect to server:**
   - Double-click "PostgreSQL 16" in the left sidebar
   - Enter the password you set during installation

3. **Create database:**
   - Right-click "Databases" → "Create" → "Database"
   - Database name: `execution_wall`
   - Owner: `postgres`
   - Click "Save"

## Step 5: Configure Backend

1. **Navigate to backend folder:**
   ```cmd
   cd "C:\Users\Rodin\Documents\wall 2\Execution-Wall8\backend"
   ```

2. **Edit `.env` file:**
   Open `backend\.env` in a text editor and update:
   ```env
   DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/execution_wall?schema=public"
   ```

   Replace `YOUR_PASSWORD` with the password you set in Step 2.

   Example:
   ```env
   DATABASE_URL="postgresql://postgres:postgres123@localhost:5432/execution_wall?schema=public"
   ```

3. **Save the file**

## Step 6: Run Database Migrations

1. **Open Command Prompt** in the backend folder

2. **Generate Prisma Client:**
   ```cmd
   npx prisma generate
   ```

3. **Run migrations** (creates all tables):
   ```cmd
   npx prisma migrate dev --name init
   ```

   You should see:
   ```
   ✅ Your database is now in sync with your Prisma schema
   ✅ Generated Prisma Client
   ```

4. **Verify tables were created:**
   ```cmd
   npx prisma studio
   ```

   This opens a web interface at http://localhost:5555 where you can see all tables.

## Step 7: Start Backend Server

1. **Start the development server:**
   ```cmd
   npm run dev
   ```

2. **You should see:**
   ```
   ✅ Server running on http://localhost:3000
   📊 Environment: development
   🔗 Frontend URL: http://localhost:5173
   💾 Database: 80 MB limit with auto-cleanup
   🕐 Starting database cleanup scheduler (runs every hour)
   🧹 Starting database cleanup...
      Current size: 0.12 MB / 80.00 MB
      ✅ Database size OK, skipping cleanup
   ```

## Step 8: Test the Backend

Open a new Command Prompt window and test the webhook:

```cmd
curl -X POST http://localhost:3000/api/webhook/tradingview -H "Content-Type: application/json" -d "{\"ticker\":\"AAPL\",\"dir\":\"Long\",\"price\":175.50,\"quality_tier\":\"A\",\"quality_score\":85}"
```

**Expected response:**
```json
{
  "success": true,
  "intent_id": "...",
  "message": "Trade intent created successfully"
}
```

## Step 9: View Database Data

### Option A: Prisma Studio (Easy GUI)
```cmd
cd backend
npx prisma studio
```
Opens http://localhost:5555 - you can view all tables and data.

### Option B: pgAdmin 4
1. Open pgAdmin 4
2. Navigate: PostgreSQL 16 → Databases → execution_wall → Schemas → public → Tables
3. Right-click any table → "View/Edit Data" → "All Rows"

## Database Location

Your database files are stored locally at:
```
C:\Program Files\PostgreSQL\16\data\
```

All data stays on your computer - nothing is sent to the cloud.

## Database Size Management

The system automatically maintains an 80 MB database limit:

**Automatic Cleanup (runs every hour):**
- Deletes trade intents older than 30 days
- Deletes webhook logs older than 14 days
- Deletes audit logs older than 60 days
- Deletes closed positions older than 90 days
- Keeps all open positions and active trades

**View Database Stats:**
```cmd
curl http://localhost:3000/api/database/stats
```

**Manual Cleanup:**
```cmd
curl -X POST http://localhost:3000/api/database/cleanup
```

## Troubleshooting

### Error: "psql: command not found"
**Solution:** Add PostgreSQL to PATH
1. Search "Environment Variables" in Windows
2. Edit "Path" in System Variables
3. Add: `C:\Program Files\PostgreSQL\16\bin`
4. Restart Command Prompt

### Error: "database 'execution_wall' does not exist"
**Solution:** Create the database (see Step 4)

### Error: "password authentication failed"
**Solution:** Check password in `backend\.env` matches PostgreSQL password

### Error: "port 5432 is already in use"
**Solution:** PostgreSQL is already running (this is normal)

### Can't connect to database
**Solution:** Ensure PostgreSQL service is running
1. Open Services (Win + R, type `services.msc`)
2. Find "postgresql-x64-16"
3. Right-click → Start (if not running)

## Uninstall (if needed)

1. Open "Add or Remove Programs"
2. Uninstall "PostgreSQL 16"
3. Delete folder: `C:\Program Files\PostgreSQL\16`
4. Delete folder: `C:\Users\{YourName}\AppData\Roaming\postgresql`

## Next Steps

Once PostgreSQL is running and migrations are complete:

1. ✅ Backend is ready
2. ➡️ Start frontend: `npm run dev` (from root folder)
3. ➡️ Test webhook integration with TradingView
4. ➡️ Create WebhookLogs UI page to monitor incoming signals

## Quick Reference Commands

```cmd
# Check PostgreSQL version
psql --version

# Start backend server
cd backend
npm run dev

# View database in browser
cd backend
npx prisma studio

# Test webhook
curl -X POST http://localhost:3000/api/webhook/tradingview -H "Content-Type: application/json" -d "{\"ticker\":\"TEST\",\"dir\":\"Long\",\"price\":100}"

# View webhook logs
curl http://localhost:3000/api/webhook/logs

# View database stats
curl http://localhost:3000/api/database/stats

# Manual database cleanup
curl -X POST http://localhost:3000/api/database/cleanup
```

## Storage Estimates

With 80 MB limit:

| Trading Volume | History Duration |
|----------------|-----------------|
| 10 signals/day  | ~7 years        |
| 50 signals/day  | ~18 months      |
| 200 signals/day | ~4 months       |

Old data is automatically deleted to make room for new data.
