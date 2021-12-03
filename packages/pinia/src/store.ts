import {
  watch,
  computed,
  inject,
  getCurrentInstance,
  reactive,
  DebuggerEvent,
  WatchOptions,
  UnwrapRef,
  markRaw,
  isRef,
  isReactive,
  effectScope,
  EffectScope,
  ComputedRef,
  toRef,
  toRefs,
  Ref,
  ref,
  set,
  del,
  isVue2
} from 'vue-demi'
import {
  StateTree,
  SubscriptionCallback,
  DeepPartial,
  isPlainObject,
  Store,
  _Method,
  DefineStoreOptions,
  StoreDefinition,
  _GettersTree,
  MutationType,
  StoreOnActionListener,
  _ActionsTree,
  SubscriptionCallbackMutation,
  DefineSetupStoreOptions,
  DefineStoreOptionsInPlugin,
  StoreGeneric,
  _StoreWithGetters,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
  _StoreWithState
} from './types'
import { setActivePinia, piniaSymbol, Pinia, activePinia } from './rootStore'
import { IS_CLIENT } from './env'
import { patchObject } from './hmr'
import { addSubscription, triggerSubscriptions } from './subscriptions'

//递归合并响应式对象
function mergeReactiveObjects<T extends StateTree> (
  target: T,
  patchToApply: DeepPartial<T>
): T {
  // 无需遍历符号，因为无论如何它们都无法序列化
  for (const key in patchToApply) {
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)
    } else {
      // @ts-expect-error: subPatch is a valid value
      target[key] = subPatch
    }
  }

  return target
}

const skipHydrateSymbol = __DEV__
  ? Symbol('pinia:skipHydration')
  : /* istanbul ignore next */ Symbol()
const skipHydrateMap = /*#__PURE__*/ new WeakMap<any, any>()

export function skipHydrate<T = any> (obj: T): T {
  return isVue2
    ? // in @vue/composition-api, the refs are sealed so defineProperty doesn't work...
    /* istanbul ignore next */ skipHydrateMap.set(obj, 1) && obj
    : Object.defineProperty(obj, skipHydrateSymbol, {})
}

function shouldHydrate (obj: any) {
  return isVue2
    ? /* istanbul ignore next */ skipHydrateMap.has(obj)
    : !isPlainObject(obj) || !obj.hasOwnProperty(skipHydrateSymbol)
}

const {assign} = Object

function isComputed<T> (value: ComputedRef<T> | unknown): value is ComputedRef<T>
function isComputed (o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}

function createOptionsStore<Id extends string,
  S extends StateTree,
  G extends _GettersTree<S>,
  A extends _ActionsTree> (
  id: Id,
  options: DefineStoreOptions<Id, S, G, A>,
  pinia: Pinia,
  hot?: boolean
): Store<Id, S, G, A> {
  const {state, actions, getters} = options

  const initialState: StateTree | undefined = pinia.state.value[id]

  let store: Store<Id, S, G, A>

  function setup () {
    //没有已初始化state则初始化
    if (!initialState && (!__DEV__ || !hot)) {
      /* istanbul ignore if */
      if (isVue2) {
        set(pinia.state.value, id, state ? state() : {})
      } else {
        pinia.state.value[id] = state ? state() : {}
      }
    }

    // 将state转换为原生数据，方便createSetupStore生成store
    // ？避免在pinia.state.value中创建状态
    const localState =
      __DEV__ && hot
        ? // 使用ref()打开状态内部的ref
        toRefs(ref(state ? state() : {}).value)
        : toRefs(pinia.state.value[id])

    //将action、getter合并到state，方便createSetupStore生成store
    return assign(
      localState,
      actions,
      //遍历getters，并将其组合成新对象
      Object.keys(getters || {}).reduce((computedGetters, name) => {
        computedGetters[name] = markRaw(
          computed(() => {
            setActivePinia(pinia)
            // 在调用之前，store就已存在，所以可以直接get
            const store = pinia._s.get(id)!

            // store没有准备就绪则直接返回
            /* istanbul ignore next */
            if (isVue2 && !store._r) return

            // @ts-expect-error
            // 调用对应name的getter并指定this为store
            return getters![name].call(store, store)
          })
        )
        return computedGetters
      }, {} as Record<string, ComputedRef>)
    )
  }

  store = createSetupStore(id, setup, options, pinia, hot)

  store.$reset = function $reset () {
    const newState = state ? state() : {}
    // 我们使用补丁程序将所有更改分组为一个订阅
    this.$patch(($state) => {
      assign($state, newState)
    })
  }

  return store as any
}

const noop = () => {
}

function createSetupStore<Id extends string,
  SS,
  S extends StateTree,
  G extends Record<string, _Method>,
  A extends _ActionsTree> (
  $id: Id,
  setup: () => SS,
  options:
    | DefineSetupStoreOptions<Id, S, G, A>
    | DefineStoreOptions<Id, S, G, A> = {},
  pinia: Pinia,
  hot?: boolean
): Store<Id, S, G, A> {
  let scope!: EffectScope
  //构建中的state（只有当不是setup方式调用时才有这个值）
  const buildState = (options as DefineStoreOptions<Id, S, G, A>).state

  //插件的配置
  const optionsForPlugin: DefineStoreOptionsInPlugin<Id, S, G, A> = assign(
    {actions: {} as A},
    options
  )

  /* istanbul ignore if */
  if (__DEV__ && !pinia._e.active) {//开发模式下作用于没有处于活动状态则抛出错误
    throw new Error('Pinia destroyed')
  }

  // 订阅的观察者选项
  const $subscribeOptions: WatchOptions = {
    deep: true
    // flush: 'post',
  }
  /* istanbul ignore else */
  if (__DEV__ && !isVue2) {
    //不是vue2的开发环境下定义触发器，当订阅被触发时，会先执行触发器，然后再执行订阅回调
    $subscribeOptions.onTrigger = (event) => {
      /* istanbul ignore else */
      if (isListening) {
        debuggerEvents = event
      } else if (isListening == false && !store._hotUpdating) {// 避免在建立商店并在pinia设置状态时触发此触发
        // 让patch稍后将所有事件一起发送
        /* istanbul ignore else */
        if (Array.isArray(debuggerEvents)) {
          debuggerEvents.push(event)
        } else {
          console.error(
            '🍍 debuggerEvents should be an array. This is most likely an internal Pinia bug.'
          )
        }
      }
    }
  }

  // 内部状态
  let isListening: boolean //当前是否在监听（最后设置为true）
  //订阅回调队列，用于在$patch方法最后触发订阅回调
  let subscriptions: SubscriptionCallback<S>[] = markRaw([])
  //action订阅回调队列，在action被调用时触发
  let actionSubscriptions: StoreOnActionListener<Id, S, G, A>[] = markRaw([])
  //调试器事件，用于发送Vue devtools支持的事件
  let debuggerEvents: DebuggerEvent[] | DebuggerEvent
  //从pinia实例中取出已创建的state（没有则为undefined）
  const initialState = pinia.state.value[$id] as UnwrapRef<S> | undefined

  // 如果是setup方式创建且是第一次创建，则初始化state
  if (!buildState && !initialState && (!__DEV__ || !hot)) {
    /* istanbul ignore if */
    if (isVue2) {
      set(pinia.state.value, $id, {})
    } else {
      pinia.state.value[$id] = {}
    }
  }

  //热更新state，只在开发环境热更新模式下使用
  const hotState = ref({} as S)

  //为Store打补丁的方法
  function $patch (stateMutation: (state: UnwrapRef<S>) => void): void
  function $patch (partialState: DeepPartial<UnwrapRef<S>>): void
  function $patch (
    partialStateOrMutator:
      | DeepPartial<UnwrapRef<S>>
      | ((state: UnwrapRef<S>) => void)
  ): void {
    let subscriptionMutation: SubscriptionCallbackMutation<S>
    isListening = false
    // 重置调试器事件，因为补丁是同步的
    /* istanbul ignore else */
    if (__DEV__) {
      debuggerEvents = []
    }
    if (typeof partialStateOrMutator === 'function') {
      // 传入的target其实是store.$state，所以更新的其实是这个对象，
      // 所以如果是新增而不是修改的话是不会更新到store对象中的
      partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>)
      subscriptionMutation = {
        type: MutationType.patchFunction,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[]
      }
    } else {
      // 传入的target其实是store.$state，所以更新的其实是这个对象，
      // 所以如果是新增而不是修改的话是不会更新到store对象中的
      mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)
      subscriptionMutation = {
        type: MutationType.patchObject,
        payload: partialStateOrMutator,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[]
      }
    }
    isListening = true
    // 手动调用订阅方法以重新启用观察者
    triggerSubscriptions(
      subscriptions,
      subscriptionMutation,
      pinia.state.value[$id] as UnwrapRef<S>
    )
  }

  /* istanbul ignore next */
  const $reset = __DEV__
    ? () => {
      throw new Error(
        `🍍: Store "${$id}" is build using the setup syntax and does not implement $reset().`
      )
    }
    : noop

  //销毁当前Store
  function $dispose () {
    scope.stop()
    subscriptions = []
    actionSubscriptions = []
    pinia._s.delete($id)
  }

  /**
   * 包装处理订阅的操作。
   *
   * @param name - 操作名称
   * @param action - 要换行的动作
   * @returns 用于处理订阅的包装操作
   */
  function wrapAction (name: string, action: _Method) {
    return function (this: any) {
      setActivePinia(pinia)
      //参数转数组
      const args = Array.from(arguments)

      let afterCallback: (resolvedReturn: any) => any = noop
      let onErrorCallback: (error: unknown) => unknown = noop

      function after (callback: typeof afterCallback) {
        afterCallback = callback
      }

      function onError (callback: typeof onErrorCallback) {
        onErrorCallback = callback
      }

      // @ts-expect-error
      triggerSubscriptions(actionSubscriptions, {
        args,
        name,
        store,
        after,
        onError
      })

      let ret: any
      try {
        //this是Store对象，而使用setup方式创建的Store对象拿不到this
        ret = action.apply(this && this.$id === $id ? this : store, args)
      } catch (error) {
        // 处理同步错误
        if (onErrorCallback(error) !== false) {
          throw error
        }
      }

      //如果action的结果是期约，则返回期约
      if (ret instanceof Promise) {
        return ret
          .then((value) => {
            const newRet = afterCallback(value)
            // 如果afterCallback没有返回值，则返回期约解决值是value
            return newRet === undefined ? value : newRet
          })
          .catch((error) => {
            if (onErrorCallback(error) !== false) {
              return Promise.reject(error)
            }
          })
      }

      // 如果afterCallback没有返回值，则返回ret
      const newRet = afterCallback(ret)
      return newRet === undefined ? ret : newRet
    }
  }

  //热模块更换荷载，只在客户端开发环境下使用
  const _hmrPayload = /*#__PURE__*/ markRaw({
    actions: {} as Record<string, any>,
    getters: {} as Record<string, Ref>,
    state: [] as string[],
    hotState
  })

  //定义Store对象的固有属性、方法
  const partialStore = {
    _p: pinia,
    // _s: scope,
    $id,
    $onAction: addSubscription.bind(null, actionSubscriptions),
    $patch,
    $reset,
    //订阅state变化。添加订阅回调到订阅回调队列，然后返回移除观察函数
    $subscribe (callback, options = {}) {
      const _removeSubscription = addSubscription(
        subscriptions,
        callback,
        options.detached
      )
      const stopWatcher = scope.run(() =>
        //监听当前Store的state，如果发生变化就触发事件（当前处于监听状态时）
        watch(
          () => pinia.state.value[$id] as UnwrapRef<S>,
          (state) => {
            if (isListening) {
              callback(
                {
                  storeId: $id,
                  type: MutationType.direct,
                  events: debuggerEvents as DebuggerEvent
                },
                state
              )
            }
          },
          assign({}, $subscribeOptions, options)
        )
      )!

      const removeSubscription = () => {
        stopWatcher()
        _removeSubscription()
      }

      return removeSubscription
    },
    $dispose
  } as _StoreWithState<Id, S, G, A>

  /* istanbul ignore if */
  if (isVue2) {
    // vue2，标记为未准备就绪
    partialStore._r = false
  }

  //利用vue的响应系统创建store
  const store: Store<Id, S, G, A> = reactive(
    assign(
      __DEV__ && IS_CLIENT
        ? // devtools自定义属性（开发环境下才有）
        {
          _customProperties: markRaw(new Set<string>()),
          _hmrPayload
        }
        : {},
      partialStore
      // 后面会将setupStore合并到当前对象
    )
  ) as unknown as Store<Id, S, G, A>

  // 将Store存储到映射中，方便存取值
  pinia._s.set($id, store)

  //根据setup函数运行结果创建响应对象
  const setupStore = pinia._e.run(() => {
    scope = effectScope()
    return scope.run(() => setup())
  })!

  // 处理setup中的state、action、getter
  for (const key in setupStore) {
    const prop = setupStore[key]

    //处理state（非响应数据不处理，所以也不会添加到state）
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // 将其标记为要序列化的状态
      if (__DEV__ && hot) {
        set(hotState.value, key, toRef(setupStore as any, key))
      } else if (!buildState) {
        // buildState有值则代表是createOptionStore调用的（直接在pinia.state.value中设置状态），所以跳过
        // 在setup创建store模式中，我们必须将state与用户刚刚创建的refs进行水合并同步pinia状态树
        if (initialState && shouldHydrate(prop)) {
          if (isRef(prop)) {
            prop.value = initialState[key]
          } else {
            // 可能是响应对象，递归合并
            mergeReactiveObjects(prop, initialState[key])
          }
        }
        // 将ref传输到pinia的state以保持所有内容同步,pinia.state.value[$id]等价于store.$state
        /* istanbul ignore if */
        if (isVue2) {
          set(pinia.state.value[$id], key, prop)
        } else {
          pinia.state.value[$id][key] = prop
        }
      }

      /* istanbul ignore else */
      if (__DEV__) {
        _hmrPayload.state.push(key)
      }
    } else if (typeof prop === 'function') {
      // 如果是函数则代表是action
      // @ts-expect-error: we are overriding the function we avoid wrapping if
      const actionValue = __DEV__ && hot ? prop : wrapAction(key, prop)
      // 将action添加到setupStore上
      /* istanbul ignore if */
      if (isVue2) {
        set(setupStore, key, actionValue)
      } else {
        // @ts-expect-error
        setupStore[key] = actionValue
      }

      /* istanbul ignore else */
      if (__DEV__) {
        _hmrPayload.actions[key] = prop
      }

      // 列出操作，以便它们可以在插件中使用
      // @ts-expect-error
      optionsForPlugin.actions[key] = prop
    } else if (__DEV__) {
      // 为devtools添加getter
      if (isComputed(prop)) {
        _hmrPayload.getters[key] = buildState
          ? // @ts-expect-error
          options.getters[key]
          : prop
        if (IS_CLIENT) {
          const getters: string[] =
            // @ts-expect-error: it should be on the store
            setupStore._getters || (setupStore._getters = markRaw([]))
          getters.push(key)
        }
      }
    }
  }

  // setupStore处理完之后合并到store对象
  /* istanbul ignore if */
  if (isVue2) {
    Object.keys(setupStore).forEach((key) => {
      set(
        store,
        key,
        // @ts-expect-error: valid key indexing
        setupStore[key]
      )
    })
  } else {
    assign(store, setupStore)
  }

  // 使用此功能代替带有setter的计算，以便能够在任何地方创建它，而无需将计算的使用寿命链接到首次创建存储的任何位置。
  Object.defineProperty(store, '$state', {
    //将store.$state与pinia.state.value[$id]/hotState相关联
    get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id]),
    set: (state) => {
      /* istanbul ignore if */
      if (__DEV__ && hot) {
        throw new Error('cannot set hotState')
      }
      $patch(($state) => {
        assign($state, state)
      })
    }
  })

  // 在插件之前添加热更新，以允许他们覆盖它
  /* istanbul ignore else */
  if (__DEV__) {
    //热更新函数不会被代理
    store._hotUpdate = markRaw((newStore) => {
      store._hotUpdating = true
      //遍历state并添加到Store对象
      newStore._hmrPayload.state.forEach((stateKey) => {
        //属性冲突
        if (stateKey in store.$state) {
          const newStateTarget = newStore.$state[stateKey]
          const oldStateSource = store.$state[stateKey]
          if (
            typeof newStateTarget === 'object' &&
            isPlainObject(newStateTarget) &&
            isPlainObject(oldStateSource)
          ) {
            //普通对象则将旧state打补丁到新state
            patchObject(newStateTarget, oldStateSource)
          } else {
            // 否则转移响应数据
            newStore.$state[stateKey] = oldStateSource
          }
        }
        // 将属性响应化，然后添加到store对象中
        set(store, stateKey, toRef(newStore.$state, stateKey))
      })

      // 删除不在新state的属性
      Object.keys(store.$state).forEach((stateKey) => {
        if (!(stateKey in newStore.$state)) {
          del(store, stateKey)
        }
      })

      // 更新state（为了避免devtools记录突变，需要先暂停监听）
      isListening = false
      pinia.state.value[$id] = toRef(newStore._hmrPayload, 'hotState')
      isListening = true

      //设置action到store对象中
      for (const actionName in newStore._hmrPayload.actions) {
        const action: _Method = newStore[actionName]

        set(store, actionName, wrapAction(actionName, action))
      }

      // 设置getter到store对象
      for (const getterName in newStore._hmrPayload.getters) {
        const getter: _Method = newStore._hmrPayload.getters[getterName]
        const getterValue = buildState
          ? // option模式下创建的Store需要设置this为store
          computed(() => {
            setActivePinia(pinia)
            return getter.call(store, store)
          })
          : getter

        set(store, getterName, getterValue)
      }

      // 删除新store中没有的getter
      Object.keys(store._hmrPayload.getters).forEach((key) => {
        if (!(key in newStore._hmrPayload.getters)) {
          del(store, key)
        }
      })

      // 删除新store中没有的action
      Object.keys(store._hmrPayload.actions).forEach((key) => {
        if (!(key in newStore._hmrPayload.actions)) {
          del(store, key)
        }
      })

      // 更新Vue devtools中使用的值，并允许稍后删除新属性
      store._hmrPayload = newStore._hmrPayload
      store._getters = newStore._getters
      store._hotUpdating = false
    })

    //不可枚举配置
    const nonEnumerable = {
      writable: true,
      configurable: true,
      // 避免在尝试显示此属性的devtools上发出警告
      enumerable: false
    }

    if (IS_CLIENT) {
      // 避免在devtools中列出内部属性（不可枚举属性不会被列出）
      ;(
        ['_p', '_hmrPayload', '_getters', '_customProperties'] as const
      ).forEach((p) => {
        Object.defineProperty(store, p, {
          value: store[p],
          ...nonEnumerable
        })
      })
    }
  }

  /* istanbul ignore if */
  if (isVue2) {
    // 在插件安装之前将store标记为准备就绪
    store._r = true
  }

  // 安装所有插件
  pinia._p.forEach((extender) => {
    /* istanbul ignore else */
    if (__DEV__ && IS_CLIENT) {
      const extensions = scope.run(() =>
        extender({
          store,
          app: pinia._a,
          pinia,
          options: optionsForPlugin
        })
      )!
      //添加扩展项到自定义属性
      Object.keys(extensions || {}).forEach((key) =>
        store._customProperties.add(key)
      )
      //将插件返回的内容添加到store对象
      assign(store, extensions)
    } else {
      //将插件返回的内容添加到store对象
      assign(
        store,
        scope.run(() =>
          extender({
            store,
            app: pinia._a,
            pinia,
            options: optionsForPlugin
          })
        )!
      )
    }
  })

  //开发环境下不是普通对象则输出错误
  if (
    __DEV__ &&
    store.$state &&
    typeof store.$state === 'object' &&
    typeof store.$state.constructor === 'function' &&
    !store.$state.constructor.toString().includes('[native code]')
  ) {
    console.warn(
      `[🍍]: The "state" must be a plain object. It cannot be\n` +
      `\tstate: () => new MyClass()\n` +
      `Found in store "${store.$id}".`
    )
  }

  // 仅对pinia初始化过对应state且是option方式创建的Store应用水合
  if (
    initialState &&
    buildState &&
    (options as DefineStoreOptions<Id, S, G, A>).hydrate
  ) {
    ;(options as DefineStoreOptions<Id, S, G, A>).hydrate!(
      store.$state,
      initialState
    )
  }

  isListening = true
  return store
}

// export function disposeStore(store: StoreGeneric) {
//   store._e

// }

/**
 * Extract the actions of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreActions<SS> = SS extends Store<string,
    StateTree,
    _GettersTree<StateTree>,
    infer A>
  ? A
  : _ExtractActionsFromSetupStore<SS>

/**
 * Extract the getters of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreGetters<SS> = SS extends Store<string,
    StateTree,
    infer G,
    _ActionsTree>
  ? _StoreWithGetters<G>
  : _ExtractGettersFromSetupStore<SS>

/**
 * Extract the state of a store type. Works with both a Setup Store or an
 * Options Store. Note this unwraps refs.
 */
export type StoreState<SS> = SS extends Store<string,
    infer S,
    _GettersTree<StateTree>,
    _ActionsTree>
  ? UnwrapRef<S>
  : _ExtractStateFromSetupStore<SS>

// type a1 = _ExtractStateFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a2 = _ExtractActionsFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a3 = _ExtractGettersFromSetupStore<{
//   a: Ref<number>
//   b: ComputedRef<string>
//   action: () => void
// }>

/**
 * 创建一个 “usestore” 函数，该函数检索存储实例
 *
 * @param id - 商店的id (必须唯一)
 * @param options - 定义商店的选项
 */
export function defineStore<Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}> (
  id: Id,
  options: Omit<DefineStoreOptions<Id, S, G, A>, 'id'>
): StoreDefinition<Id, S, G, A>

/**
 * 创建一个 “usestore” 函数，该函数检索存储实例
 *
 * @param options - 定义商店的选项
 */
export function defineStore<Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}> (options: DefineStoreOptions<Id, S, G, A>): StoreDefinition<Id, S, G, A>

/**
 *创建一个 “usestore” 函数，该函数检索存储实例
 *
 * @param id - 商店的id (必须唯一)
 * @param storeSetup - 定义存储的函数
 * @param options - 额外选项
 */
export function defineStore<Id extends string, SS> (
  id: Id,
  storeSetup: () => SS,
  options?: DefineSetupStoreOptions<Id,
    _ExtractStateFromSetupStore<SS>,
    _ExtractGettersFromSetupStore<SS>,
    _ExtractActionsFromSetupStore<SS>>
): StoreDefinition<Id,
  _ExtractStateFromSetupStore<SS>,
  _ExtractGettersFromSetupStore<SS>,
  _ExtractActionsFromSetupStore<SS>>
export function defineStore (
  // TODO: add proper types from above
  idOrOptions: any,
  setup?: any,
  setupOptions?: any
): StoreDefinition {
  let id: string
  let options:
    | DefineStoreOptions<string,
    StateTree,
    _GettersTree<StateTree>,
    _ActionsTree>
    | DefineSetupStoreOptions<string,
    StateTree,
    _GettersTree<StateTree>,
    _ActionsTree>

  //初始化参数
  const isSetupStore = typeof setup === 'function'
  if (typeof idOrOptions === 'string') {
    id = idOrOptions
    // 在这种情况下，选项存储设置将包含实际选项
    options = isSetupStore ? setupOptions : setup
  } else {
    options = idOrOptions
    id = idOrOptions.id
  }

  function useStore (pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
    const currentInstance = getCurrentInstance()
    pinia =
      // 在测试模式下，忽略提供的参数，因为我们总是可以使用getActivePinia()检索pinia实例
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      //测试模式下注入piniaSymbol
      (currentInstance && inject(piniaSymbol))
    if (pinia) setActivePinia(pinia)

    if (__DEV__ && !activePinia) {
      throw new Error(
        `[🍍]: getActivePinia was called with no active Pinia. Did you forget to install pinia?\n` +
        `\tconst pinia = createPinia()\n` +
        `\tapp.use(pinia)\n` +
        `This will fail in production.`
      )
    }

    pinia = activePinia!

    //如果映射中没有对应id的store则创建（避免重复创建）
    if (!pinia._s.has(id)) {
      // 创建store并将其注册在'pinia._ s'中，同时兼容setup语法和option语法
      if (isSetupStore) {
        createSetupStore(id, setup, options, pinia)
      } else {
        createOptionsStore(id, options as any, pinia)
      }

      /* istanbul ignore else */
      if (__DEV__) {
        // @ts-expect-error: not the right inferred type
        useStore._pinia = pinia
      }
    }

    //然后获取对应id的store
    const store: StoreGeneric = pinia._s.get(id)!

    //开发环境下传入hot代表热更新hot对象，创建一个新的Store对象并将其热更新到hot对象
    if (__DEV__ && hot) {
      const hotId = '__hot:' + id
      const newStore = isSetupStore
        ? createSetupStore(hotId, setup, options, pinia, true)
        : createOptionsStore(hotId, assign({}, options) as any, pinia, true)

      //目标对象热更新
      hot._hotUpdate(newStore)

      // 清除本次热更新产生的副作用
      delete pinia.state.value[hotId]
      pinia._s.delete(hotId)
    }

    // 在实例中保存缓存供devtools访问
    if (
      __DEV__ &&
      IS_CLIENT &&
      currentInstance &&
      currentInstance.proxy &&
      // 避免添加刚刚为热模块更换而构建的store
      !hot
    ) {
      const vm = currentInstance.proxy
      const cache = '_pStores' in vm ? vm._pStores! : (vm._pStores = {})
      cache[id] = store
    }

    // StoreGeneric不能向store强制转换
    return store as any
  }

  useStore.$id = id

  return useStore
}
