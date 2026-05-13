export function useNotifications() {
  const notifySupport = import.meta.client && 'Notification' in window

  const permission = computed(() => {
    if (!notifySupport) return 'denied'
    return Notification.permission
  })

  async function requestPermission(): Promise<NotificationPermission> {
    if (!notifySupport) return 'denied'
    return Notification.requestPermission()
  }

  function notify(title: string, opts?: NotificationOptions): Notification | null {
    if (!notifySupport) return null
    if (permission.value !== 'granted') return null
    return new Notification(title, opts)
  }

  return { notifySupport, permission, requestPermission, notify }
}
