# POS Billing Backend Scaffold

This directory contains a local Express backend scaffold for the POS Billing frontend.

## Install

```bash
cd server
npm install
```

## Run

```bash
npm start
```

The backend will start on `http://localhost:4000` by default.

## Frontend configuration

To use the local backend from the frontend, set the API base in the frontend root `.env`:

```env
REACT_APP_API_BASE=http://localhost:4000
```

Then restart the frontend.

## Supported API routes

- `POST /api/login`
- `POST /api/logout`
- `GET /api/auth/user`
- `GET /api/register/available`
- `POST /api/register`
- `POST /api/password-reset/request`
- `POST /api/password-reset/confirm`
- `GET /api/store-settings`
- `POST /api/store-settings`
- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/products`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `GET /api/services`
- `POST /api/services`
- `PUT /api/services/:id`
- `DELETE /api/services/:id`
- `GET /api/expenses`
- `POST /api/expenses`
- `PUT /api/expenses/:id`
- `DELETE /api/expenses/:id`
- `GET /api/orders`
- `POST /api/orders`
- `PUT /api/orders/:id`
- `DELETE /api/orders/:id`
- `GET /api/invoices`
- `POST /api/invoices`
- `GET /api/invoices/:invoiceNo`
- `GET /api/customer-credits`
- `POST /api/customer-credits`
- `PUT /api/customer-credits/:id`
- `DELETE /api/customer-credits/:id`
- `GET /api/hotel/tables`
- `POST /api/hotel/tables`
- `PUT /api/hotel/tables/:id`
- `DELETE /api/hotel/tables/:id`
- `GET /api/hotel/waiting`
- `POST /api/hotel/waiting`
- `DELETE /api/hotel/waiting/:id`
- `GET /api/hotel/checkout-history`
- `POST /api/hotel/checkout-history`
- `DELETE /api/hotel/checkout-history`
- `DELETE /api/hotel/checkout-history/:id`
- `GET /api/hotel/dining-bills`
- `PUT /api/hotel/dining-bills/:tableId`
- `DELETE /api/hotel/dining-bills/:tableId`

## Notes

- The backend uses the existing JSON files in `server/data/`.
- Authentication is cookie-based. The server sets `sessionId` as a cookie.
- If you want to deploy this backend, ensure the CORS origin matches your frontend origin and that cookies are configured correctly.
