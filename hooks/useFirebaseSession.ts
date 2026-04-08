import { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider } from '../lib/firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc, getDocs, collection, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

export function useFirebaseSession() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [sessionId, setSessionId] = useState<string>('default');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        // Ensure user document exists
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: currentUser.uid,
              email: currentUser.email,
              name: currentUser.displayName,
              role: 'user',
              createdAt: serverTimestamp()
            });
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${currentUser.uid}`);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const login = useCallback(async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login error:', error);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout error:', error);
    }
  }, []);

  const saveSession = useCallback(async (data: any) => {
    if (!user) return;
    try {
      const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
      const sessionSnap = await getDoc(sessionRef);
      
      const payload = {
        uid: user.uid,
        ...data,
        updatedAt: serverTimestamp()
      };

      if (!sessionSnap.exists()) {
        payload.createdAt = serverTimestamp();
      }

      await setDoc(sessionRef, payload, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/sessions/${sessionId}`);
    }
  }, [user, sessionId]);

  const loadSession = useCallback(async () => {
    if (!user) return null;
    try {
      const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
      const sessionSnap = await getDoc(sessionRef);
      if (sessionSnap.exists()) {
        return sessionSnap.data();
      }
      return null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/sessions/${sessionId}`);
      return null;
    }
  }, [user, sessionId]);

  const loadAllSessions = useCallback(async () => {
    if (!user) return [];
    try {
      const sessionsRef = collection(db, 'users', user.uid, 'sessions');
      const sessionsSnap = await getDocs(sessionsRef);
      return sessionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/sessions`);
      return [];
    }
  }, [user]);

  return { user, isAuthReady, login, logout, sessionId, setSessionId, saveSession, loadSession, loadAllSessions };
}
