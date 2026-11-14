# Eplug Partner API — Хамтрагч мерчантын интеграцийн баримтжуулалт

Eplug цэнэглэх станцын нэгдсэн системтэй холбогдох хамтрагч байгууллагууд (Partner merchants, Kiosk, Аппликэйшн, Fleet удирдлага, Тээврийн систем)-д зориулсан RESTful API гарын авлага.

---

## 1. Ерөнхий ойлголт (Overview)

- **Үндсэн хаяг (Base URL)**: `https://eplug.mn/api/partner` (Хөгжүүлэлт: `http://localhost:3000/api/partner`)
- **Протокол**: HTTPS
- **Өгөгдлийн формат**: JSON (`Content-Type: application/json; charset=utf-8`)
- **Нэвтрэлтийн төрөл**: OAuth2 / Bearer Token (`Authorization: Bearer <accessToken>`)
- **Токен хугацаа**:
  - `accessToken`: 2 цаг (7200 секунд)
  - `refreshToken`: 30 хоног (Автомат эргэлт / Token rotation)

---

## 2. Аюулгүй байдал ба Хандалтын хяналт (Security & Access Control)

1. **IP Whitelist**: Eplug админ таны хүсэлтийн дагуу зөвхөн танай серверийн тодорхой IP хаягуудаас хандахаар тохируулах боломжтой.
2. **Scopes (Эрхийн хязгаарлалт)**:
   - `stations:read` — Станцуудын жагсаалт, бодит цагийн төлөв харах
   - `connectors:read` — Буу / Холбогчдын цэнэглэж буй эсэх төлөв харах
   - `sessions:read` — Цэнэглэлтийн сесс, кВтц, явцын телеметр харах
   - `sessions:control` — Алсаас цэнэглэлт эхлүүлэх ба зогсоох
   - `tariffs:read` — Цахилгааны тариф харах
3. **Станцын хязгаарлалт**:
   - Мерчантад бүх станц руу хандах эсвэл зөвхөн гэрээт станцууд руу хандах эрх олгогдоно.

---

## 3. Нэвтрэлт ба Токен (Authentication Flow)

```
[Хамтрагч систем]                                     [Eplug CSMS API]
       │                                                      │
       │── 1. POST /auth/login { username, password } ───────►│
       │◄── 2. 200 OK { accessToken, refreshToken } ─────────│
       │                                                      │
       │── 3. GET /stations (Header: Bearer <accessToken>) ──►│
       │◄── 4. 200 OK [ stations data ] ──────────────────────│
       │                                                      │
       │── 5. (2 цагийн дараа Token дуусахад)                 │
       │      POST /auth/refresh { refreshToken } ───────────►│
       │◄── 6. 200 OK { new accessToken, new refreshToken } ──│
```

### 3.1. Нэвтэрч токен авах (Login)
Шинээр хандалт хийхдээ админаас олгосон `username` болон `password`-оор нэвтэрч токен авна.

- **Method & Endpoint**: `POST /auth/login`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "username": "your_merchant_username",
  "password": "your_password"
}
```

- **Амжилттай хариу (200 OK)**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "7c9e1f82b3a4c5d6e7f8a9b0c1d2e3f4...",
  "tokenType": "Bearer",
  "expiresIn": 7200,
  "merchant": {
    "id": "6735e01b7a2d4c001f3b8912",
    "name": "Токи ХХК",
    "code": "toki",
    "username": "toki_api",
    "scopes": [
      "stations:read",
      "connectors:read",
      "sessions:read",
      "sessions:control"
    ],
    "allowedStations": []
  }
}
```

---

### 3.2. Токен сэргээх (Refresh Token)
`accessToken`-ийн 2 цагийн хугацаа дуусахад хэрэглэгчийн нэр, нууц үг дахин оруулалгүйгээр `refreshToken`-ээрээ шинэ access токен авна. Хуучин refreshToken автоматаар хүчингүй болж шинэ refreshToken үүснэ (Token Rotation).

- **Method & Endpoint**: `POST /auth/refresh`
- **Request Body**:
```json
{
  "refreshToken": "7c9e1f82b3a4c5d6e7f8a9b0c1d2e3f4..."
}
```

- **Амжилттай хариу (200 OK)**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "a1b2c3d4e5f6...",
  "tokenType": "Bearer",
  "expiresIn": 7200
}
```

---

### 3.3. Токен цуцлах / Гарах (Revoke / Logout)
Тухайн мерчантын бүх идэвхтэй токеныг хүчингүй болгоно.

- **Method & Endpoint**: `POST /auth/revoke`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Хариу (200 OK)**:
```json
{
  "ok": true,
  "message": "Бүх идэвхтэй токен цуцлагдлаа"
}
```

---

## 4. API Endpoints Reference

Бүх хамгаалагдсан хүсэлтэд толгой хэсэгт `Authorization: Bearer <accessToken>` дамжуулна.

---

### 4.1. Мерчантын мэдээлэл харах
Тухайн мерчантын профайл, эрхүүд, зөвшөөрөгдсөн станцуудын мэдээлэл.

- **Method & Endpoint**: `GET /me`
- **Хариу (200 OK)**:
```json
{
  "id": "6735e01b7a2d4c001f3b8912",
  "name": "Токи ХХК",
  "code": "toki",
  "username": "toki_api",
  "scopes": ["stations:read", "connectors:read", "sessions:read", "sessions:control"],
  "allowedStations": [],
  "rateLimitPerMin": 120,
  "totalApiCalls": 45,
  "lastLoginAt": "2026-11-14T11:20:00.000Z"
}
```

---

### 4.2. Станцуудын жагсаалт харах
Бүх цэнэглэх станцуудын байршил, онлайн төлөв, холбогч буунуудын төлөв (Чөлөөтэй, цэнэглэж буй гэх мэт).

- **Method & Endpoint**: `GET /stations`
- **Хариу (200 OK)**:
```json
{
  "stations": [
    {
      "id": "671234567890abcdef123456",
      "cpId": "META",
      "name": "МЕТА ЦЕНТР - Барилгын материалын худалдааны төв",
      "address": "WV6C+98V Bayangol -4 16010, Narny zam -16/5, БГД - 25 хороо, Улаанбаатар",
      "latitude": 47.9102,
      "longitude": 106.8854,
      "vendor": "Grasen",
      "model": "DC-60KW-CCS2-GBT",
      "tariffPerKwh": 850,
      "isOnline": true,
      "connectors": [
        {
          "connectorId": 1,
          "type": "CCS2",
          "powerKw": 60,
          "status": "Available",
          "errorCode": "NoError"
        },
        {
          "connectorId": 2,
          "type": "GB/T",
          "powerKw": 60,
          "status": "Charging",
          "errorCode": "NoError"
        }
      ]
    }
  ],
  "total": 1
}
```

#### Холбогчийн төлөвүүд (`status`):
- `Available` — Чөлөөтэй, цэнэглэхэд бэлэн
- `Preparing` — Холбогч машинд залгагдсан, эхлэхийг хүлээж буй
- `Charging` — Цэнэглэж байна
- `Finishing` — Цэнэглэлт дууссан, бууг салгахыг хүлээж буй
- `Unavailable` — Станц сүлжээгүй (offline) эсвэл түр ажиллахгүй байна
- `Faulted` — Техникийн алдаа гарсан

---

### 4.3. Нэг станцын дэлгэрэнгүй харах
- **Method & Endpoint**: `GET /stations/:cpId`
- **Жишээ**: `GET /stations/META`
- **Хариу (200 OK)**: Нэг станцын объект (дээрх бүтэцтэй адил).

---

### 4.4. Алсаас цэнэглэлт эхлүүлэх (Remote Start)
Хэрэглэгч апп-аас цэнэглэлт эхлүүлэх команд илгээнэ.

- **Method & Endpoint**: `POST /sessions/start`
- **Request Body**:
```json
{
  "cpId": "META",
  "connectorId": 1,
  "idTag": "TOKI-USER-99112233"
}
```
*Тайлбар: `idTag` оруулаагүй тохиолдолд танай мерчантын анхдагч ID tag автоматаар ашиглагдана.*

- **Амжилттай хариу (200 OK)**:
```json
{
  "ok": true,
  "cpId": "META",
  "connectorId": 1,
  "idTag": "TOKI-USER-99112233",
  "ocppResponse": {
    "status": "Accepted"
  }
}
```

---

### 4.5. Цэнэглэлт алсаас зогсоох (Remote Stop)
Явагдаж буй цэнэглэлтийг дуусгах команд илгээнэ.

- **Method & Endpoint**: `POST /sessions/stop`
- **Request Body**:
```json
{
  "transactionId": 10425
}
```

- **Амжилттай хариу (200 OK)**:
```json
{
  "ok": true,
  "transactionId": 10425,
  "cpId": "META",
  "ocppResponse": {
    "status": "Accepted"
  }
}
```

---

### 4.6. Явагдаж буй цэнэглэлтүүдийн жагсаалт харах
- **Method & Endpoint**: `GET /sessions/active`
- **Хариу (200 OK)**:
```json
{
  "sessions": [
    {
      "transactionId": 10425,
      "cpId": "META",
      "stationName": "МЕТА ЦЕНТР",
      "connectorId": 1,
      "idTag": "TOKI-USER-99112233",
      "startTimestamp": "2026-11-14T11:05:00.000Z",
      "currentMeterWh": 14500,
      "energyKwh": 14.5,
      "currentSoc": 65
    }
  ],
  "count": 1
}
```

---

### 4.7. Цэнэглэлтийн сессийн нарийвчилсан мэдээлэл харах
Тухайн цэнэглэлтийн эхэлсэн, дууссан цаг, зарцуулсан кВтц, үргэлжилсэн хугацаа (минут), нийт төлбөрийн дүн.

- **Method & Endpoint**: `GET /sessions/:transactionId`
- **Жишээ**: `GET /sessions/10425`
- **Хариу (200 OK)**:
```json
{
  "transactionId": 10425,
  "cpId": "META",
  "stationName": "МЕТА ЦЕНТР",
  "connectorId": 1,
  "idTag": "TOKI-USER-99112233",
  "startTimestamp": "2026-11-14T11:05:00.000Z",
  "stopTimestamp": "2026-11-14T11:35:00.000Z",
  "energyKwh": 22.45,
  "durationMin": 30,
  "cost": 19082.5,
  "stopReason": "Remote"
}
```

---

## 5. Алдааны кодууд (Error Handling)

Системээс стандартын HTTP статус код буцаана:

| HTTP Status | Тайлбар | Жишээ шалтгаан |
|---|---|---|
| `200 OK` | Амжилттай | Хүсэлт амжилттай биелсэн |
| `400 Bad Request` | Параметр буруу | Станцын ID буруу, станц холболтгүй (offline) |
| `401 Unauthorized` | Нэвтрэлт амжилтгүй | Буруу username/password, хугацаа нь дууссан эсвэл хүчингүй токен |
| `403 Forbidden` | Эрх хүрэхгүй | Мерчант хаагдсан, тухайн API эрх (Scope) байхгүй, IP зөвшөөрөгдөөгүй |
| `404 Not Found` | Өгөгдөл олдсонгүй | Станц эсвэл сесс олдсонгүй |
| `429 Too Many Requests` | Хүсэлтийн хязгаар хэтэрсэн | Секундэд хэт олон дуудалт хийсэн |
| `500 Internal Error` | Серверийн алдаа | Дотоод алдаа |

**Алдааны хариу формат**:
```json
{
  "error": "Станц \"META\" одоогоор холболтгүй (offline) байна"
}
```

---

## 6. Кодын жишээнүүд (Code Samples)

### 6.1. Node.js / TypeScript (Axios)
```typescript
import axios from 'axios';

const BASE_URL = 'https://eplug.mn/api/partner';

async function main() {
  // 1. Login
  const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
    username: 'your_merchant_username',
    password: 'your_password',
  });

  const { accessToken, refreshToken } = loginRes.data;
  console.log('Login successful! Access token:', accessToken);

  // 2. Fetch stations
  const stationsRes = await axios.get(`${BASE_URL}/stations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  console.log('Available stations:', stationsRes.data.stations);
}

main().catch(console.error);
```

### 6.2. Python (Requests)
```python
import requests

BASE_URL = "https://eplug.mn/api/partner"

# 1. Login
auth_payload = {
    "username": "your_merchant_username",
    "password": "your_password"
}
login_res = requests.post(f"{BASE_URL}/auth/login", json=auth_payload)
tokens = login_res.json()
access_token = tokens["accessToken"]

# 2. Get stations
headers = {"Authorization": f"Bearer {access_token}"}
stations_res = requests.get(f"{BASE_URL}/stations", headers=headers)
print("Stations:", stations_res.json())
```
