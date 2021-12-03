import { isRef, isReactive, isVue2, set } from 'vue-demi'
import { Pinia } from './rootStore'
import { isPlainObject, StoreDefinition, StoreGeneric, _Method } from './types'

/**
 * Checks if a function is a `StoreDefinition`.
 *
 * @param fn - object to test
 * @returns true if `fn` is a StoreDefinition
 */
export const isUseStore = (fn: any): fn is StoreDefinition => {
  return typeof fn === 'function' && typeof fn.$id === 'string'
}

/**
 * 递归将旧state补丁到新state（以新state为准）
 *
 * @param newState - 要修补的新state对象
 * @param oldState - 应该用来修补新state的旧state
 * @returns - 新state
 */
export function patchObject(
  newState: Record<string, any>,
  oldState: Record<string, any>
): Record<string, any> {
  // 无需遍历符号，因为无论如何它们都无法序列化
  for (const key in oldState) {
    const subPatch = oldState[key]

    // 新state没有这个键则直接跳过
    if (!(key in newState)) {
      continue
    }

    const targetValue = newState[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      //普通对象则直接递归
      newState[key] = patchObject(targetValue, subPatch)
    } else {
      // 对象要么是更复杂的 (例如refs)，要么是原语，所以我们只设置了整个内容
      if (isVue2) {
        set(newState, key, subPatch)
      } else {
        newState[key] = subPatch
      }
    }
  }

  return newState
}

/**
 * Creates an _accept_ function to pass to `import.meta.hot` in Vite applications.
 *
 * @example
 * ```js
 * const useUser = defineStore(...)
 * if (import.meta.hot) {
 *   import.meta.hot.accept(acceptHMRUpdate(useUser, import.meta.hot))
 * }
 * ```
 *
 * @param initialUseStore - return of the defineStore to hot update
 * @param hot - `import.meta.hot`
 */
export function acceptHMRUpdate(initialUseStore: StoreDefinition, hot: any) {
  return (newModule: any) => {
    const pinia: Pinia | undefined = hot.data.pinia || initialUseStore._pinia

    if (!pinia) {
      // this store is still not used
      return
    }

    // preserve the pinia instance across loads
    hot.data.pinia = pinia

    // console.log('got data', newStore)
    for (const exportName in newModule) {
      const useStore = newModule[exportName]
      // console.log('checking for', exportName)
      if (isUseStore(useStore) && pinia._s.has(useStore.$id)) {
        // console.log('Accepting update for', useStore.$id)
        const id = useStore.$id

        if (id !== initialUseStore.$id) {
          console.warn(
            `The id of the store changed from "${initialUseStore.$id}" to "${id}". Reloading.`
          )
          // return import.meta.hot.invalidate()
          return hot.invalidate()
        }

        const existingStore: StoreGeneric = pinia._s.get(id)!
        if (!existingStore) {
          console.log(`skipping hmr because store doesn't exist yet`)
          return
        }
        useStore(pinia, existingStore)
      }
    }
  }
}
