import { getCurrentInstance, onUnmounted } from 'vue-demi'
import { _Method } from './types'

/**
 * 添加订阅回调并返回删除订阅的函数
 * @param {T[]} subscriptions 订阅回调队列
 * @param {T} callback 回调函数
 * @param {boolean} detached 是否分离
 * @return {() => void} 返回删除订阅函数的函数
 */
export function addSubscription<T extends _Method> (
  subscriptions: T[],
  callback: T,
  detached?: boolean
) {
  //添加订阅回调
  subscriptions.push(callback)

  //删除订阅
  const removeSubscription = () => {
    const idx = subscriptions.indexOf(callback)
    if (idx > -1) {
      subscriptions.splice(idx, 1)
    }
  }

  //不分离并且当前存在应用实例，则应用卸载时删除回调（默认情况）
  if (!detached && getCurrentInstance()) {
    onUnmounted(removeSubscription)
  }

  return removeSubscription
}

export function triggerSubscriptions<T extends _Method> (
  subscriptions: T[],
  ...args: Parameters<T>
) {
  subscriptions.forEach((callback) => {
    callback(...args)
  })
}
