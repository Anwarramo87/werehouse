# 🔌 ZKTeco Physical Hardware Connection Guide

## Phase 5: Production Deployment - Local & Cloud Scenarios

---

## SCENARIO A: LOCAL INTRANET PAIRING
*PC and ZKTeco device on same physical router*

### Hardware Requirements
- ✅ ZKTeco Biometric Device (e.g., K40, F18, iClock 360)
- ✅ Ethernet cable (CAT5e or better)
- ✅ Local router/switch
- ✅ PC running NestJS backend

---

### Step 1: Configure Static IP on ZKTeco Device

#### 1.1 Access Device Menu
1. On the device, press **Menu** button
2. Navigate to: **Options → Comm. Options → Ethernet**
3. Note current IP (usually DHCP assigned)

#### 1.2 Set Static IP
```
IP Address: 192.168.1.201
Subnet Mask: 255.255.255.0
Gateway: 192.168.1.1
DNS: 8.8.8.8
```

*⚠️ Important: Choose IP in same subnet as your router (e.g., if router is 192.168.0.1, use 192.168.0.201)*

#### 1.3 Verify Settings
- Press **OK** to save
- Device will reboot
- Press **Menu → Info** to verify new IP

---

### Step 2: Network Diagnostics (Windows)

#### 2.1 Verify Connectivity - Ping Test
```powershell
ping 192.168.1.201
```

**Expected Output:**
```
Reply from 192.168.1.201: bytes=32 time<1ms TTL=64
Reply from 192.168.1.201: bytes=32 time<1ms TTL=64
```

**If timeout:** Check ethernet cable, router port, device power

#### 2.2 Verify Port 4370 - Telnet Test
```powershell
telnet 192.168.1.201 4370
```

**Expected:** Connection established (blank screen means success)

**If "Could not open connection":**
- Check device firewall settings
- Ensure port 4370 is open on device
- Try port 4371 (some models use different port)

#### 2.3 Advanced Port Check - PowerShell
```powershell
Test-NetConnection -ComputerName 192.168.1.201 -Port 4370
```

**Expected Output:**
```
ComputerName     : 192.168.1.201
RemoteAddress    : 192.168.1.201
RemotePort       : 4370
InterfaceAlias   : Ethernet
SourceAddress    : 192.168.1.100
TcpTestSucceeded : True
```

---

### Step 3: Configure NestJS Backend

#### 3.1 Update `.env` File
```env
USE_BIOMETRIC_SIMULATOR=false
BIOMETRIC_DEVICE_IP=192.168.1.201
BIOMETRIC_DEVICE_PORT=4370
```

#### 3.2 Restart Backend
```bash
cd werehouse/backend-nest
npm run start:dev
```

#### 3.3 Test Connection
```bash
curl -X GET http://localhost:5001/api/v1/biometric/status
```

**Expected Response:**
```json
{
  "mode": "hardware",
  "connected": true,
  "deviceIp": "192.168.1.201",
  "devicePort": 4370,
  "serialNumber": "DGD9190019050335134",
  "version": "Ver 6.60 Apr 28 2017"
}
```

---

### Step 4: Test Real-Time Sync

#### 4.1 Enroll Test User on Device
1. On device: **Menu → User → New User**
2. Enter User ID: **6** (will map to EMP900006)
3. Register fingerprint
4. Save

#### 4.2 Punch In/Out
- Place finger on sensor
- Device beeps and shows "Success"

#### 4.3 Trigger Backend Sync
```bash
curl -X POST http://localhost:5001/api/v1/biometric/trigger-sync
```

#### 4.4 Verify in Database
```sql
SELECT * FROM attendance_records
WHERE employeeId = 'EMP900006'
ORDER BY timestamp DESC
LIMIT 1;
```

---

## SCENARIO B: REMOTE CLOUD DEPLOYMENT
*Server on cloud VPS, Device at remote facility*

### Architecture Overview
```
┌─────────────────┐         ┌──────────────────┐
│  ZKTeco Device  │◄────────┤  Cloud VPS       │
│  (Remote Site)  │  HTTPS  │  (NestJS Backend)│
│  192.168.x.x    │  Push   │  Public IP/Domain│
└─────────────────┘         └──────────────────┘
```

---

### Step 1: Enable ADMS/Cloud Mode on Device

#### 1.1 Access Device Web Interface
1. Open browser: `http://192.168.1.201`
2. Login: `admin` / `admin` (default)
3. Navigate to: **Network Settings → Cloud Server**

#### 1.2 Configure Cloud Server
```
Server Address: api.yourcompany.com
OR
Server IP: 45.123.45.67

Port: 443 (HTTPS) or 80 (HTTP)
Protocol: HTTP Push
Push Interval: 60 seconds (1 minute)
```

#### 1.3 Set Push URL
```
Push URL: /api/v1/biometric/webhook/push
```

#### 1.4 Save & Test
- Click **Test Connection**
- Status should show "Connected"

---

### Step 2: Configure NestJS Webhook Receiver

#### 2.1 Create Webhook Controller
```typescript
// src/biometric/biometric-webhook.controller.ts
import { Controller, Post, Body, Headers } from '@nestjs/common';
import { BiometricService } from './biometric.service';

@Controller('biometric/webhook')
export class BiometricWebhookController {
  constructor(private readonly biometricService: BiometricService) {}

  /**
   * 🎯 Webhook endpoint for ZKTeco push notifications
   * Device sends attendance logs in real-time
   */
  @Post('push')
  async receivePush(
    @Body() payload: any,
    @Headers('user-agent') userAgent: string,
  ) {
    console.log('📥 Received webhook from ZKTeco:', payload);

    // Parse ZKTeco push format
    const logs = this.parseZKTecoPushPayload(payload);

    // Process and store
    await this.biometricService.processWebhookLogs(logs);

    return { success: true, received: logs.length };
  }

  /**
   * Parse ZKTeco ADMS push format
   */
  private parseZKTecoPushPayload(payload: any): any[] {
    // ZKTeco sends data in format:
    // {
    //   "sn": "DGD9190019050335134",
    //   "records": [
    //     {
    //       "user_id": "6",
    //       "time": "2026-06-11 08:37:00",
    //       "type": "0"
    //     }
    //   ]
    // }

    if (!payload.records) return [];

    return payload.records.map((record: any) => ({
      deviceUserId: parseInt(record.user_id),
      recordTime: new Date(record.time),
      checkType: parseInt(record.type),
      deviceId: payload.sn,
    }));
  }
}
```

#### 2.2 Add Webhook Service Method
```typescript
// src/biometric/biometric.service.ts

async processWebhookLogs(rawLogs: RawBiometricLog[]): Promise<void> {
  this.logger.log(`📥 Processing ${rawLogs.length} webhook logs`);

  const processedLogs = await this.processLogs(rawLogs);

  for (const log of processedLogs) {
    try {
      const dateStr = log.timestamp.toISOString().split('T')[0];

      // Check for duplicate
      const existing = await this.prisma.attendanceRecord.findFirst({
        where: {
          employeeId: log.employeeId,
          timestamp: log.timestamp,
          type: log.type,
        },
      });

      if (existing) {
        this.logger.debug(`⏭️ Skipping duplicate webhook log`);
        continue;
      }

      // Insert
      await this.prisma.attendanceRecord.create({
        data: {
          employeeId: log.employeeId,
          timestamp: log.timestamp,
          type: log.type,
          deviceId: log.deviceId,
          source: 'zkteco-webhook',
          verified: true,
          date: dateStr,
          notes: this.buildNotes(log),
        },
      });

      this.logger.log(`✅ Webhook log processed: ${log.employeeId}`);
    } catch (error) {
      this.logger.error(`❌ Webhook log error: ${error.message}`);
    }
  }
}
```

---

### Step 3: Secure Cloud VPS Configuration

#### 3.1 Nginx Reverse Proxy (Recommended)
```nginx
# /etc/nginx/sites-available/warehouse

server {
    listen 443 ssl http2;
    server_name api.yourcompany.com;

    ssl_certificate /etc/letsencrypt/live/api.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourcompany.com/privkey.pem;

    # Rate limiting for webhook
    limit_req_zone $binary_remote_addr zone=webhook_limit:10m rate=10r/s;

    location /api/v1/biometric/webhook/ {
        limit_req zone=webhook_limit burst=20 nodelay;

        proxy_pass http://localhost:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/v1/ {
        proxy_pass http://localhost:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

#### 3.2 Firewall Rules
```bash
# Allow webhook access only
sudo ufw allow from 203.0.113.0/24 to any port 443 proto tcp comment 'ZKTeco Device IP Range'

# Or if device has dynamic IP, allow all (less secure):
sudo ufw allow 443/tcp
```

---

### Step 4: Router Configuration (Port Forwarding)

#### If Device Behind NAT Router:

1. Access router admin panel (usually `192.168.1.1`)
2. Navigate to: **Port Forwarding / Virtual Server**
3. Add rule:
```
Service Name: ZKTeco-Webhook
External Port: 8443
Internal IP: 192.168.1.201
Internal Port: 80
Protocol: TCP
```

4. On device, set cloud server:
```
Server: your-public-ip:8443
```

---

### Step 5: Testing Cloud Setup

#### 5.1 Test Webhook Endpoint
```bash
curl -X POST https://api.yourcompany.com/api/v1/biometric/webhook/push \
  -H "Content-Type: application/json" \
  -d '{
    "sn": "DGD9190019050335134",
    "records": [
      {
        "user_id": "6",
        "time": "2026-06-11 08:37:00",
        "type": "0"
      }
    ]
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "received": 1
}
```

#### 5.2 Monitor Webhook Logs
```bash
# On VPS
tail -f /var/log/nginx/access.log | grep webhook

# In NestJS
# Watch for: "📥 Received webhook from ZKTeco"
```

#### 5.3 Live Test
1. Punch in/out on physical device
2. Wait 60 seconds (push interval)
3. Check database for new record

---

## Security Best Practices

### 1. Webhook Authentication
```typescript
@Post('push')
async receivePush(
  @Body() payload: any,
  @Headers('x-webhook-secret') secret: string,
) {
  // Verify secret token
  if (secret !== process.env.BIOMETRIC_WEBHOOK_SECRET) {
    throw new UnauthorizedException('Invalid webhook secret');
  }

  // Process...
}
```

### 2. IP Whitelist
```typescript
// src/common/guards/webhook-ip-guard.ts
@Injectable()
export class WebhookIpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ip = request.ip;

    const allowedIps = process.env.BIOMETRIC_ALLOWED_IPS.split(',');
    return allowedIps.includes(ip);
  }
}
```

### 3. HTTPS Only
```env
BIOMETRIC_WEBHOOK_REQUIRE_HTTPS=true
```

---

## Troubleshooting Guide

### Local Connection Issues

| Problem | Solution |
|---------|----------|
| Ping fails | Check ethernet cable, device power, same subnet |
| Port 4370 closed | Enable TCP socket on device menu |
| "Connection refused" | Firewall blocking, try different port |
| Sync timeout | Increase timeout in code (default 10s) |

### Cloud Connection Issues

| Problem | Solution |
|---------|----------|
| Device can't reach cloud | Check internet connection, DNS resolution |
| Webhook not received | Verify nginx config, check firewall rules |
| SSL certificate error | Device might not support HTTPS, use HTTP |
| Push interval too long | Reduce to 30 seconds for faster updates |

---

## Maintenance & Monitoring

### Daily Checks
```bash
# Check sync status
curl http://localhost:5001/api/v1/biometric/status

# Check last sync time
SELECT MAX(timestamp) FROM attendance_records WHERE source = 'zkteco';
```

### Weekly Tasks
- Review error logs
- Verify no missing employees
- Check device storage (clear old logs if > 50k records)

### Monthly Tasks
- Update device firmware
- Backup attendance database
- Review sync performance metrics

---

## Production Deployment Checklist

- [ ] ✅ Static IP configured on device
- [ ] ✅ Ping test successful
- [ ] ✅ Port 4370 accessible
- [ ] ✅ Backend .env updated
- [ ] ✅ Test employee enrolled
- [ ] ✅ Manual sync works
- [ ] ✅ Duplicate prevention verified
- [ ] ✅ Cloud webhook (if applicable) tested
- [ ] ✅ HTTPS/SSL certificate installed
- [ ] ✅ Firewall rules configured
- [ ] ✅ Monitoring alerts set up
- [ ] ✅ Backup procedures in place

---

🎉 **Integration Complete!** Your ZKTeco biometric system is now fully operational.
