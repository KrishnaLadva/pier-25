import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDocFromServer,
  initializeFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {}, firebaseConfig.firestoreDatabaseId);

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();

export async function signInWithGooglePopup() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  const idToken = await cred.user.getIdToken();
  await ensureUserDocumentsInFirestore(cred.user);
  return { firebaseUser: cred.user, idToken };
}

export async function signOutFirebase() {
  try {
    await signOut(auth);
  } catch {
    // Ignore if not signed into Firebase
  }
}

export function subscribeFirebaseAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function ensureUserDocumentsInFirestore(firebaseUser) {
  if (!firebaseUser?.uid || !firebaseUser.emailVerified) return;
  const publicRef = doc(db, 'users', firebaseUser.uid);
  const privateRef = doc(db, 'users', firebaseUser.uid, 'private', 'info');
  const displayName = String(firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Guest').slice(0, 80);

  try {
    const snap = await getDocFromServer(publicRef).catch(() => null);
    if (!snap || !snap.exists()) {
      await setDoc(publicRef, {
        uid: firebaseUser.uid,
        displayName,
        loyaltyPoints: 0,
        totalLoyaltyEarned: 0,
        totalOrders: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(publicRef, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${firebaseUser.uid}`);
  }

  try {
    await setDoc(
      privateRef,
      {
        uid: firebaseUser.uid,
        email: String(firebaseUser.email || '').slice(0, 160),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${firebaseUser.uid}/private/info`);
  }
}

export async function syncOrderToFirestore(order) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || !order?.id) return;
  const orderPath = `orders/${order.id}`;
  try {
    await setDoc(doc(db, 'orders', order.id), {
      id: order.id,
      userId: user.uid,
      customerName: String(order.customerName || 'Guest').slice(0, 80),
      itemCount: Number(order.itemCount || 1),
      total: Number(order.total || 0),
      status: order.status || 'confirmed',
      paymentStatus: order.paymentStatus || 'verified',
      paymentReference: String(order.paymentReference || '').slice(0, 80),
      orderType: order.orderType || 'delivery',
      tableNumber: String(order.tableNumber || '').slice(0, 24),
      deliveryAddress: String(order.deliveryAddress || '').slice(0, 240),
      notes: String(order.notes || '').slice(0, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, orderPath);
  }
}

export async function syncReservationToFirestore(reservation) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || !reservation?.id) return;
  const path = `reservations/${reservation.id}`;
  try {
    await setDoc(doc(db, 'reservations', reservation.id), {
      id: reservation.id,
      userId: user.uid,
      name: String(reservation.name || '').slice(0, 80),
      date: reservation.date,
      time: reservation.time,
      partySize: Number(reservation.partySize),
      status: reservation.status || 'confirmed',
      notes: String(reservation.notes || '').slice(0, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function syncReviewToFirestore(review) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || !review?.id) return;
  const path = `reviews/${review.id}`;
  try {
    await setDoc(doc(db, 'reviews', review.id), {
      id: review.id,
      userId: user.uid,
      authorName: String(review.authorName || 'Guest').slice(0, 80),
      rating: Number(review.rating),
      comment: String(review.comment || '').slice(0, 500),
      dishId: String(review.dishId || '').slice(0, 128),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function syncMenuItemToFirestore(item) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !item?.id) return;
  const path = `menuItems/${item.id}`;
  try {
    await setDoc(doc(db, 'menuItems', item.id), {
      id: String(item.id).slice(0, 128),
      name: String(item.name || '').slice(0, 100),
      category: String(item.category || '').slice(0, 50),
      subcategory: String(item.subcategory || '').slice(0, 80),
      showcaseSection: String(item.showcaseSection || '').slice(0, 80),
      description: String(item.description || '').slice(0, 500),
      price: item.price === null || item.price === undefined ? null : Number(item.price),
      discountPrice: item.discountPrice === null || item.discountPrice === undefined ? null : Number(item.discountPrice),
      comboPrice: item.comboPrice === null || item.comboPrice === undefined ? null : Number(item.comboPrice),
      comboLabel: String(item.comboLabel || '').slice(0, 100),
      dietaryType: item.dietaryType === 'non-veg' ? 'non-veg' : 'veg',
      imageUrl: String(item.imageUrl || 'dish.png').slice(0, 300),
      ingredients: Array.isArray(item.ingredients) ? item.ingredients.slice(0, 25) : [],
      dietaryTags: Array.isArray(item.dietaryTags) ? item.dietaryTags.slice(0, 10) : [],
      customisationOptions: Array.isArray(item.customisationOptions) ? item.customisationOptions.slice(0, 10) : [],
      prepMinutes: Math.max(1, Math.min(240, Math.round(Number(item.prepMinutes || 10)))),
      calories: Math.max(0, Math.min(5000, Math.round(Number(item.calories || 250)))),
      available: item.available !== false,
      stockStatus: ['in_stock', 'low_stock', 'out_of_stock'].includes(item.stockStatus) ? item.stockStatus : 'in_stock',
      isPopular: Boolean(item.isBestseller || item.isPopular),
      isBestseller: Boolean(item.isBestseller || item.isPopular),
      isNew: Boolean(item.isNewArrival || item.isNew),
      isNewArrival: Boolean(item.isNewArrival || item.isNew),
      isRecommended: Boolean(item.isRecommended),
      isDailySpecial: Boolean(item.isDailySpecial),
      dailySpecialPrice: item.dailySpecialPrice === null || item.dailySpecialPrice === undefined ? null : Number(item.dailySpecialPrice),
      dailySpecialStartedAt: item.dailySpecialStartedAt ? String(item.dailySpecialStartedAt).slice(0, 40) : null,
      dailySpecialExpiresAt: item.dailySpecialExpiresAt ? String(item.dailySpecialExpiresAt).slice(0, 40) : null,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteMenuItemFromFirestore(itemId) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !itemId) return;
  const path = `menuItems/${itemId}`;
  try {
    await deleteDoc(doc(db, 'menuItems', itemId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncInventoryItemToFirestore(item) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !item?.id) return;
  const path = `inventory/${item.id}`;
  try {
    await setDoc(doc(db, 'inventory', item.id), {
      id: String(item.id).slice(0, 128),
      name: String(item.name || '').slice(0, 100),
      sku: String(item.sku || 'KRD-001').slice(0, 40),
      unit: String(item.unit || 'units').slice(0, 30),
      stockQty: Math.max(0, Number(item.stockQty ?? 0)),
      reorderLevel: Math.max(0, Number(item.reorderLevel ?? 0)),
      costPerUnit: Math.max(0, Number(item.costPerUnit ?? 0)),
      linkedDishIds: Array.isArray(item.linkedDishIds) ? item.linkedDishIds.slice(0, 50) : [],
      lowStockAlertAt: item.stockQty <= item.reorderLevel ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteInventoryItemFromFirestore(itemId) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !itemId) return;
  const path = `inventory/${itemId}`;
  try {
    await deleteDoc(doc(db, 'inventory', itemId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncEliteGuestToFirestore(guest) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !guest?.uid) return;
  const path = `eliteGuests/${guest.uid}`;
  try {
    await setDoc(doc(db, 'eliteGuests', guest.uid), {
      uid: String(guest.uid).slice(0, 128),
      displayName: String(guest.displayName || 'Guest').slice(0, 80),
      tier: ['Grand Reserve', 'Gold Circle', 'Forest Patron', 'Club Guest'].includes(guest.tier)
        ? guest.tier
        : 'Club Guest',
      totalLoyaltyEarned: Math.max(0, Math.round(Number(guest.totalLoyaltyEarned || 0))),
      loyaltyPoints: Math.max(0, Math.round(Number(guest.loyaltyPoints || 0))),
      totalOrders: Math.max(0, Math.round(Number(guest.totalOrders || 0))),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncTableSessionToFirestore(session) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || !session?.id) return;
  const path = `tableSessions/${session.id}`;
  try {
    await setDoc(doc(db, 'tableSessions', session.id), {
      id: String(session.id).slice(0, 128),
      tableLabel: String(session.tableLabel || 'Table').slice(0, 24),
      zone: String(session.zone || 'Main Dining').slice(0, 40),
      seats: Math.max(1, Math.min(20, Math.round(Number(session.seats || 4)))),
      status: 'occupied',
      source: ['qr_scanner', 'qr_link', 'owner_manual', 'dine_in_order'].includes(session.source)
        ? session.source
        : 'qr_scanner',
      userId: user.uid,
      guestName: String(session.guestName || user.displayName || 'Guest').slice(0, 80),
      partySize: Math.max(1, Math.min(20, Math.round(Number(session.partySize || session.seats || 2)))),
      activeOrderIds: Array.isArray(session.activeOrderIds) ? session.activeOrderIds.slice(0, 20) : [],
      checkedInAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function releaseTableSessionFromFirestore(tableId) {
  const user = auth.currentUser;
  if (!user?.uid || !user.emailVerified || user.email !== 'krishnaladva25@gmail.com' || !tableId) return;
  const path = `tableSessions/${tableId}`;
  try {
    await deleteDoc(doc(db, 'tableSessions', tableId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}


