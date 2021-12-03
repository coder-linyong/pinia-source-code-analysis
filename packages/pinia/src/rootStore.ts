import {
  App,
  EffectScope,
  getCurrentInstance,
  inject,
  InjectionKey,
  Ref,
} from 'vue-demi'
import {
  StateTree,
  PiniaCustomProperties,
  _Method,
  Store,
  _GettersTree,
  _ActionsTree,
  PiniaCustomStateProperties,
  DefineStoreOptionsInPlugin,
  StoreGeneric,
} from './types'

/**
 * 必须调用setActivePinia来处理 “获取” 、 “设置” 、 “服务器预取” 等函数顶部的SSR
 */
export let activePinia: Pinia | undefined

/**
 * 设置或取消设置活动的pinia。在SSR和内部调用操作和getter时使用
 *
 * @param pinia - Pinia实例
 */
export const setActivePinia = (pinia: Pinia | undefined) =>
  (activePinia = pinia)

/**
 * Get the currently active pinia if there is any.
 */
export const getActivePinia = () =>
  (getCurrentInstance() && inject(piniaSymbol)) || activePinia

/**
 * 每个应用程序都必须拥有自己的pinia才能创建商店
 */
export interface Pinia {
  install: (app: App) => void

  /**
   * 根state
   */
  state: Ref<Record<string, StateTree>>

  /**
   * 添加一个商店插件来扩展每个商店
   *
   * @param plugin - 要添加的商店插件
   */
  use(plugin: PiniaPlugin): Pinia

  /**
   * 已安装的store插件
   *
   * @internal
   */
  _p: PiniaPlugin[]

  /**
   * 链接到此Pinia实例的应用程序
   *
   * @internal
   */
  _a: App

  /**
   * 附着Pinia的作用范围
   *
   * @internal
   */
  _e: EffectScope

  /**
   * 此pinia使用的store映射
   *
   * @internal
   */
  _s: Map<string, StoreGeneric>

  /**
   * 由 'createTestingPinia()'添加以绕过 'useStore(pinia)'。
   *
   * @internal
   */
  _testing?: boolean
}

export const piniaSymbol = (
  __DEV__ ? Symbol('pinia') : /* istanbul ignore next */ Symbol()
) as InjectionKey<Pinia>

/**
 * Context argument passed to Pinia plugins.
 */
export interface PiniaPluginContext<
  Id extends string = string,
  S extends StateTree = StateTree,
  G /* extends _GettersTree<S> */ = _GettersTree<S>,
  A /* extends _ActionsTree */ = _ActionsTree
> {
  /**
   * pinia instance.
   */
  pinia: Pinia

  /**
   * Current app created with `Vue.createApp()`.
   */
  app: App

  /**
   * Current store being extended.
   */
  store: Store<Id, S, G, A>

  /**
   * Current store being extended.
   */
  options: DefineStoreOptionsInPlugin<Id, S, G, A>
}

/**
 * 每个store的扩展插件
 */
export interface PiniaPlugin {
  /**
   * 插件扩展每个商店。返回一个对象来扩展存储或什么都没有。
   *
   * @param context - 上下文
   */
  (context: PiniaPluginContext): Partial<
    PiniaCustomProperties & PiniaCustomStateProperties
  > | void
}

/**
 * Plugin to extend every store.
 * @deprecated use PiniaPlugin instead
 */
export type PiniaStorePlugin = PiniaPlugin
