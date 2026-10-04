import AsyncStorage from "@react-native-async-storage/async-storage";
import { DraftRepository } from "./conversation/draft.js";

// Shared by the composer and local cleanup without importing the connection Store.
export const drafts = new DraftRepository(AsyncStorage);
