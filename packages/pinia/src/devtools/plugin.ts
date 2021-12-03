import {
  setupDevtoolsPlugin,
  TimelineEvent,
  App as DevtoolsApp,
} from '@vue/devtools-api'
import { ComponentPublicInstance, markRaw, toRaw, unref, watch } from 'vue-demi'
import { Pinia, PiniaPluginContext } from '../rootStore'
import {
  _GettersTree,
  MutationType,
  StateTree,
  _ActionsTree,
  StoreGeneric,
} from '../types'
import {
  actionGlobalCopyState,
  actionGlobalPasteState,
  actionGlobalSaveState,
  actionGlobalOpenStateFile,
} from './actions'
import {
  formatDisplay,
  formatEventData,
  formatMutationType,
  formatStoreForInspectorState,
  formatStoreForInspectorTree,
  PINIA_ROOT_ID,
  PINIA_ROOT_LABEL,
} from './formatting'
import { isPinia, toastMessage } from './utils'

// timeline can be paused when directly changing the state
let isTimelineActive = true
const componentStateTypes: string[] = []

const MUTATIONS_LAYER_ID = 'pinia:mutations'
const INSPECTOR_ID = 'pinia'

/**
 * Gets the displayed name of a store in devtools
 *
 * @param id - id of the store
 * @returns a formatted string
 */
const getStoreType = (id: string) => '🍍 ' + id

/**
 * 添加没有任何store的pinia插件。允许将Pinia插件选项卡添加到应用程序后立即显示它。
 *
 * @param app - Vue应用
 * @param pinia - pinia实例
 */
export function registerPiniaDevtools(app: DevtoolsApp, pinia: Pinia) {
  setupDevtoolsPlugin(
    {
      id: 'dev.esm.pinia',
      label: 'Pinia 🍍',
      logo: 'https://pinia.esm.dev/logo.svg',
      packageName: 'pinia',
      homepage: 'https://pinia.esm.dev',
      componentStateTypes,
      app,
    },
    (api) => {
      api.addTimelineLayer({
        id: MUTATIONS_LAYER_ID,
        label: `Pinia 🍍`,
        color: 0xe5df88,
      })

      api.addInspector({
        id: INSPECTOR_ID,
        label: 'Pinia 🍍',
        icon: 'storage',
        treeFilterPlaceholder: 'Search stores',
        actions: [
          {
            icon: 'content_copy',
            action: () => {
              actionGlobalCopyState(pinia)
            },
            tooltip: 'Serialize and copy the state',
          },
          {
            icon: 'content_paste',
            action: async () => {
              await actionGlobalPasteState(pinia)
              api.sendInspectorTree(INSPECTOR_ID)
              api.sendInspectorState(INSPECTOR_ID)
            },
            tooltip: 'Replace the state with the content of your clipboard',
          },
          {
            icon: 'save',
            action: () => {
              actionGlobalSaveState(pinia)
            },
            tooltip: 'Save the state as a JSON file',
          },
          {
            icon: 'folder_open',
            action: async () => {
              await actionGlobalOpenStateFile(pinia)
              api.sendInspectorTree(INSPECTOR_ID)
              api.sendInspectorState(INSPECTOR_ID)
            },
            tooltip: 'Import the state from a JSON file',
          },
        ],
      })

      api.on.inspectComponent((payload, ctx) => {
        const proxy = (payload.componentInstance &&
          payload.componentInstance.proxy) as
          | ComponentPublicInstance
          | undefined
        if (proxy && proxy._pStores) {
          const piniaStores = (
            payload.componentInstance.proxy as ComponentPublicInstance
          )._pStores!

          Object.values(piniaStores).forEach((store) => {
            payload.instanceData.state.push({
              type: getStoreType(store.$id),
              key: 'state',
              editable: true,
              value: store.$state,
            })

            if (store._getters && store._getters.length) {
              payload.instanceData.state.push({
                type: getStoreType(store.$id),
                key: 'getters',
                editable: false,
                value: store._getters.reduce((getters, key) => {
                  getters[key] = store[key]
                  return getters
                }, {} as _GettersTree<StateTree>),
              })
            }
          })
        }
      })

      api.on.getInspectorTree((payload) => {
        if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
          let stores: Array<StoreGeneric | Pinia> = [pinia]
          stores = stores.concat(Array.from(pinia._s.values()))

          payload.rootNodes = (
            payload.filter
              ? stores.filter((store) =>
                  '$id' in store
                    ? store.$id
                        .toLowerCase()
                        .includes(payload.filter.toLowerCase())
                    : PINIA_ROOT_LABEL.toLowerCase().includes(
                        payload.filter.toLowerCase()
                      )
                )
              : stores
          ).map(formatStoreForInspectorTree)
        }
      })

      api.on.getInspectorState((payload) => {
        if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
          const inspectedStore =
            payload.nodeId === PINIA_ROOT_ID
              ? pinia
              : pinia._s.get(payload.nodeId)

          if (!inspectedStore) {
            // this could be the selected store restored for a different project
            // so it's better not to say anything here
            return
          }

          if (inspectedStore) {
            payload.state = formatStoreForInspectorState(inspectedStore)
          }
        }
      })

      api.on.editInspectorState((payload, ctx) => {
        if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
          const inspectedStore =
            payload.nodeId === PINIA_ROOT_ID
              ? pinia
              : pinia._s.get(payload.nodeId)

          if (!inspectedStore) {
            return toastMessage(`store "${payload.nodeId}" not found`, 'error')
          }

          const { path } = payload

          if (!isPinia(inspectedStore)) {
            // access only the state
            if (
              path.length !== 1 ||
              !inspectedStore._customProperties.has(path[0]) ||
              path[0] in inspectedStore.$state
            ) {
              path.unshift('$state')
            }
          } else {
            // Root access, we can omit the `.value` because the devtools API does it for us
            path.unshift('state')
          }
          isTimelineActive = false
          payload.set(inspectedStore, path, payload.state.value)
          isTimelineActive = true
        }
      })

      api.on.editComponentState((payload) => {
        if (payload.type.startsWith('🍍')) {
          const storeId = payload.type.replace(/^🍍\s*/, '')
          const store = pinia._s.get(storeId)

          if (!store) {
            return toastMessage(`store "${storeId}" not found`, 'error')
          }

          const { path } = payload
          if (path[0] !== 'state') {
            return toastMessage(
              `Invalid path for store "${storeId}":\n${path}\nOnly state can be modified.`
            )
          }

          // rewrite the first entry to be able to directly set the state as
          // well as any other path
          path[0] = '$state'
          isTimelineActive = false
          payload.set(store, path, payload.state.value)
          isTimelineActive = true
        }
      })
    }
  )
}

function addStoreToDevtools(app: DevtoolsApp, store: StoreGeneric) {
  if (!componentStateTypes.includes(getStoreType(store.$id))) {
    componentStateTypes.push(getStoreType(store.$id))
  }

  setupDevtoolsPlugin(
    {
      id: 'dev.esm.pinia',
      label: 'Pinia 🍍',
      logo: 'https://pinia.esm.dev/logo.svg',
      packageName: 'pinia',
      homepage: 'https://pinia.esm.dev',
      componentStateTypes,
      app,
    },
    (api) => {
      store.$onAction(({ after, onError, name, args }) => {
        const groupId = runningActionId++

        api.addTimelineEvent({
          layerId: MUTATIONS_LAYER_ID,
          event: {
            time: Date.now(),
            title: '🛫 ' + name,
            subtitle: 'start',
            data: {
              store: formatDisplay(store.$id),
              action: formatDisplay(name),
              args,
            },
            groupId,
          },
        })

        after((result) => {
          activeAction = undefined
          api.addTimelineEvent({
            layerId: MUTATIONS_LAYER_ID,
            event: {
              time: Date.now(),
              title: '🛬 ' + name,
              subtitle: 'end',
              data: {
                store: formatDisplay(store.$id),
                action: formatDisplay(name),
                args,
                result,
              },
              groupId,
            },
          })
        })

        onError((error) => {
          activeAction = undefined
          api.addTimelineEvent({
            layerId: MUTATIONS_LAYER_ID,
            event: {
              time: Date.now(),
              logType: 'error',
              title: '💥 ' + name,
              subtitle: 'end',
              data: {
                store: formatDisplay(store.$id),
                action: formatDisplay(name),
                args,
                error,
              },
              groupId,
            },
          })
        })
      }, true)

      store._customProperties.forEach((name) => {
        watch(
          () => unref(store[name]),
          (newValue, oldValue) => {
            api.notifyComponentUpdate()
            api.sendInspectorState(INSPECTOR_ID)
            if (isTimelineActive) {
              api.addTimelineEvent({
                layerId: MUTATIONS_LAYER_ID,
                event: {
                  time: Date.now(),
                  title: 'Change',
                  subtitle: name,
                  data: {
                    newValue,
                    oldValue,
                  },
                  groupId: activeAction,
                },
              })
            }
          },
          { deep: true }
        )
      })

      store.$subscribe(
        ({ events, type }, state) => {
          api.notifyComponentUpdate()
          api.sendInspectorState(INSPECTOR_ID)

          if (!isTimelineActive) return
          // rootStore.state[store.id] = state

          const eventData: TimelineEvent = {
            time: Date.now(),
            title: formatMutationType(type),
            data: {
              store: formatDisplay(store.$id),
              ...formatEventData(events),
            },
            groupId: activeAction,
          }

          // reset for the next mutation
          activeAction = undefined

          if (type === MutationType.patchFunction) {
            eventData.subtitle = '⤵️'
          } else if (type === MutationType.patchObject) {
            eventData.subtitle = '🧩'
          } else if (events && !Array.isArray(events)) {
            eventData.subtitle = events.type
          }

          if (events) {
            eventData.data['rawEvent(s)'] = {
              _custom: {
                display: 'DebuggerEvent',
                type: 'object',
                tooltip: 'raw DebuggerEvent[]',
                value: events,
              },
            }
          }

          api.addTimelineEvent({
            layerId: MUTATIONS_LAYER_ID,
            event: eventData,
          })
        },
        { detached: true, flush: 'sync' }
      )

      const hotUpdate = store._hotUpdate
      store._hotUpdate = markRaw((newStore) => {
        hotUpdate(newStore)
        api.addTimelineEvent({
          layerId: MUTATIONS_LAYER_ID,
          event: {
            time: Date.now(),
            title: '🔥 ' + store.$id,
            subtitle: 'HMR update',
            data: {
              store: formatDisplay(store.$id),
              info: formatDisplay(`HMR update`),
            },
          },
        })
        // update the devtools too
        api.notifyComponentUpdate()
        api.sendInspectorTree(INSPECTOR_ID)
        api.sendInspectorState(INSPECTOR_ID)
      })

      const { $dispose } = store
      store.$dispose = () => {
        $dispose()
        api.notifyComponentUpdate()
        api.sendInspectorTree(INSPECTOR_ID)
        api.sendInspectorState(INSPECTOR_ID)
        toastMessage(`Disposed "${store.$id}" store 🗑`)
      }

      // trigger an update so it can display new registered stores
      api.notifyComponentUpdate()
      api.sendInspectorTree(INSPECTOR_ID)
      api.sendInspectorState(INSPECTOR_ID)
      toastMessage(`"${store.$id}" store installed 🆕`)
    }
  )
}

let runningActionId = 0
let activeAction: number | undefined

/**
 * 通过使用作为所有操作的上下文传递的代理包装存储来修补存储以启用devtools中的操作分组，
 * 从而使我们能够在每次访问中设置 “runningaction'，并有效地将任何状态突变与操作相关联。
 *
 * @param store - store to patch
 * @param actionNames - list of actionst to patch
 */
function patchActionForGrouping(store: StoreGeneric, actionNames: string[]) {
  // original actions of the store as they are given by pinia. 我们要覆盖它
  //将取出action组成新对象
  const actions = actionNames.reduce((storeActions, actionName) => {
    // 使用toRaw避免跟踪
    storeActions[actionName] = toRaw(store)[actionName]
    return storeActions
  }, {} as _ActionsTree)

  for (const actionName in actions) {
    store[actionName] = function () {
      // setActivePinia(store._p)
      // 运行中action的id会在action钩子函数中递增
      const _actionId = runningActionId
      //使用Proxy追踪
      const trackedStore = new Proxy(store, {
        get(...args) {
          activeAction = _actionId
          return Reflect.get(...args)
        },
        set(...args) {
          activeAction = _actionId
          return Reflect.set(...args)
        },
      })
      return actions[actionName].apply(
        trackedStore,
        arguments as unknown as any[]
      )
    }
  }
}

/**
 * pinia.use(devtoolsPlugin)
 */
export function devtoolsPlugin<
  Id extends string = string,
  S extends StateTree = StateTree,
  G /* extends GettersTree<S> */ = _GettersTree<S>,
  A /* extends ActionsTree */ = _ActionsTree
>({ app, store, options }: PiniaPluginContext<Id, S, G, A>) {
  // HMR module
  if (store.$id.startsWith('__hot:')) {
    return
  }

  // 仅在选项定义的存储中包装操作，因为此技术依赖于使用代理包装操作的上下文
  if (typeof options.state === 'function') {
    patchActionForGrouping(
      // @ts-expect-error: can cast the store...
      store,
      Object.keys(options.actions)
    )

    const originalHotUpdate = store._hotUpdate

    // 升级HMR以更新新action
    toRaw(store)._hotUpdate = function (newStore) {
      originalHotUpdate.apply(this, arguments as any)
      patchActionForGrouping(
        store as StoreGeneric,
        Object.keys(newStore._hmrPayload.actions)
      )
    }
  }

  addStoreToDevtools(
    // @ts-expect-error: should be of type App from vue
    app,
    // FIXME: is there a way to allow the assignment from Store<Id, S, G, A> to StoreGeneric?
    store as StoreGeneric
  )
}
