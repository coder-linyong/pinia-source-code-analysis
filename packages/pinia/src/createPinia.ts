import { Pinia, PiniaPlugin, setActivePinia, piniaSymbol } from './rootStore'
import { ref, App, markRaw, effectScope, isVue2 } from 'vue-demi'
import { registerPiniaDevtools, devtoolsPlugin } from './devtools'
import { IS_CLIENT } from './env'
import { StateTree, StoreGeneric } from './types'

/**
 * 创建应用程序使用的Pinia实例
 */
export function createPinia (): Pinia {
  const scope = effectScope(true)
  // 注: 在这里，我们可以检查窗口对象的状态，并直接设置它，如果有类似的Vue 3 SSR
  const state = scope.run(() => ref<Record<string, StateTree>>({}))!

  //已安装插件
  let _p: Pinia['_p'] = []
  // 调用app.use(pinia)前添加的待安装插件
  let toBeInstalled: PiniaPlugin[] = []

  //使Pinia对象永远不会转换成Proxy
  const pinia: Pinia = markRaw({
    //pinia被安装时调用
    install (app: App) {
      // 这允许在安装pinia的插件后在组件设置之外调用useStore()
      setActivePinia(pinia)
      if (!isVue2) {
        pinia._a = app
        app.provide(piniaSymbol, pinia)
        //相当于Vue.prototype.$pinia = pinia
        app.config.globalProperties.$pinia = pinia
        /* istanbul ignore else */
        if (__DEV__ && IS_CLIENT) {
          //如果是客户端开发模式则注册开发工具
          // @ts-expect-error: weird type in devtools api
          registerPiniaDevtools(app, pinia)
        }
        //将添加的插件转移到_p属性中，然后清空
        toBeInstalled.forEach((plugin) => _p.push(plugin))
        toBeInstalled = []
      }
    },

    use (plugin) {
      //没有绑定Vue实例并且不是Vue2的话添加到带安装插件，否则添加到已安装插件
      if (!this._a && !isVue2) {
        toBeInstalled.push(plugin)
      } else {
        _p.push(plugin)
      }
      return this
    },

    //已安装插件
    _p,
    // 绑定的应用程序实例，这里实际上是不确定的
    // @ts-expect-error
    _a: null,
    //附着Pinia的作用范围
    _e: scope,
    //此Pinia实例使用的store映射（Map）
    _s: new Map<string, StoreGeneric>(),
    //各模块state的引用映射
    state
  })

  // pinia devtools仅依赖开发功能，因此除非使用Vue的开发版本，否则不能强制使用它们
  if (__DEV__ && IS_CLIENT) {
    pinia.use(devtoolsPlugin)
  }

  return pinia
}
