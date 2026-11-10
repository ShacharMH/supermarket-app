import { supabase } from "../supabase";

/** The public half of the key the nightly job signs notifications with (ingest/alerts.py). */
async function publicKey(): Promise<string> {
  const { data, error } = await supabase.from("app_config").select("value").eq("key", "vapid_public_key").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("ההתראות יהיו זמינות אחרי עדכון המחירים הבא");
  return data.value as string;
}

export type PushState = "unsupported" | "ios-install" | "denied" | "on" | "off";

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function keyBytes(b64: string): Uint8Array {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function pushState(): Promise<PushState> {
  // on iPhone, notifications work only in the app added to the home screen
  if (isIos() && !installed()) return "ios-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? "on" : "off";
}

/** Ask for permission, subscribe this browser and save where to send. */
export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted") return pushState();
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await publicKey()) as BufferSource }));
  const j = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    { endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  return pushState();
}
