import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SessionUser } from '../lib/api';
const session = createSlice({
  name: 'session',
  initialState: { user: null as SessionUser | null, loading: true },
  reducers: {
    signedIn: (state, action: PayloadAction<SessionUser>) => {
      state.user = action.payload;
      state.loading = false;
    },
    signedOut: (state) => {
      state.user = null;
      state.loading = false;
    },
  },
});
export const { signedIn, signedOut } = session.actions;
export const store = configureStore({ reducer: { session: session.reducer } });
export type RootState = ReturnType<typeof store.getState>;
