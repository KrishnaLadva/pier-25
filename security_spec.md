# Firestore Security Specification

## 1. Data Invariants
1. A `UserPublic` record at `/users/{userId}` may only be created or edited by the verified owner of `userId` (`request.auth.uid == userId`), and users cannot self-assign owner/admin roles or tamper with immutable `uid`/`createdAt`.
2. PII (`email`, `phone`, `address`) is strictly isolated in `/users/{userId}/private/info` and readable/writable only by `userId` or a verified admin. Listing `/users` or `/users/{userId}/private` is denied.
3. `/admins/{userId}` grants owner privileges and can only be written by an existing verified owner.
4. `/menuItems/{itemId}` is publicly readable (`get`, `list`) and writable only by verified owners (`isAdmin()`).
5. `/orders/{orderId}` can only be created by a verified signed-in customer with `userId == request.auth.uid` and non-terminal initial status `'confirmed'`. Customers may only read/list their own orders (`resource.data.userId == request.auth.uid`); owners may read and update order status. Terminal orders (`'completed'`, `'cancelled'`) are locked from customer modification.
6. `/reservations/{reservationId}` can only be created by a verified user with `userId == request.auth.uid` and initial status `'confirmed'`. Customers may read/list/cancel only their own non-terminal reservations.
7. `/reviews/{reviewId}` is publicly readable; only verified users may create reviews tied to `userId == request.auth.uid` with rating `1..5`, and only the author or an owner can delete them.

## 2. Dirty Dozen Adversarial Payloads
1. **Shadow Role Escalation**: Creating `/users/u1` with an extra field `{ role: "owner" }` or `{ isAdmin: true }` -> Rejected by `keys().hasOnly(...)`.
2. **PII Cross-Read**: Signed-in user `u2` reading `/users/u1/private/info` -> `PERMISSION_DENIED`.
3. **Admin Collection Poisoning**: Non-owner `u2` writing `/admins/u2` -> `PERMISSION_DENIED`.
4. **Unverified Email Spoofing**: Token with `email: "krishnaladva25@gmail.com"` and `email_verified: false` -> `PERMISSION_DENIED`.
5. **Order Identity Spoofing**: User `u2` creating `/orders/o1` with `userId: "u1"` -> `PERMISSION_DENIED`.
6. **Order Price/Status Tampering**: User `u1` updating `/orders/o1` `total` or `paymentStatus` -> Rejected by `affectedKeys().hasOnly(...)`.
7. **Terminal Order Reopening**: User `u1` updating an order whose `status` is `'completed'` or `'cancelled'` -> `PERMISSION_DENIED`.
8. **Menu Hijack**: Customer `u1` creating or editing `/menuItems/m1` -> `PERMISSION_DENIED`.
9. **ID Length Poisoning**: Creating `/orders/<200-char-id>` -> Rejected by `isValidId()`.
10. **String Resource Exhaustion**: Review comment > 500 chars -> Rejected by `.size() <= 500`.
11. **Timestamp Forgery**: Creating `/orders/o1` with a backdated `createdAt` not equal to `request.time` -> `PERMISSION_DENIED`.
12. **Blanket List Scraping**: User `u2` listing `/orders` without `userId == u2` -> `PERMISSION_DENIED`.
