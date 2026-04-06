<template>
  <n-config-provider :theme="currentTheme" :theme-overrides="currentThemeOverrides">
    <n-notification-provider placement="bottom-right">
      <online-status-provider>
        <splash-screen />
        <router-view />
      </online-status-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<script>
import { NConfigProvider, NNotificationProvider, darkTheme, useOsTheme } from "naive-ui";
import OnlineStatusProvider from "@/components/OnlineStatusProvider";
import SplashScreen from "@/components/SplashScreen";
import "@/assets/tailwind.css";
import {computed, ref, watch} from "vue";
import store from "@/store";

/**
 * Theme Overrides for both light and dark themes
 * @type import('naive-ui').GlobalThemeOverrides
 */
const lightThemeOverrides = {
  common: {
    primaryColor: "#0284C7",
    primaryColorHover: "#1A9DDE",
    primaryColorPressed: "#0076B1",
    textColor: "#333",
    backgroundColor: "white",
  },
};

const darkThemeOverrides = {
  common: {
    primaryColor: "#0284C7",
    primaryColorHover: "#1A9DDE",
    primaryColorPressed: "#0076B1",
    textColor: "#ddd",
    backgroundColor: "#121212",
  },
};

export default {
  name: "App",
  components: {
    NConfigProvider,
    NNotificationProvider,
    OnlineStatusProvider,
    SplashScreen,
  },
  setup() {
    const osTheme = useOsTheme();
    const themePreference = ref(store.get('settings.theme_mode', 'system'));

    const isDark = computed(() => {
      if (themePreference.value === 'dark') return true;
      if (themePreference.value === 'light') return false;
      return osTheme.value === 'dark';
    });

    // Keep the 'dark' class on <html> in sync
    const applyDarkClass = (dark) => {
      document.documentElement.classList.toggle('dark', dark);
    };
    applyDarkClass(isDark.value);
    watch(isDark, applyDarkClass);

    // Poll for settings changes (from UserSettings save)
    setInterval(() => {
      themePreference.value = store.get('settings.theme_mode', 'system');
    }, 500);

    const currentTheme = computed(() => (isDark.value ? darkTheme : null));
    const currentThemeOverrides = computed(() =>
        isDark.value ? darkThemeOverrides : lightThemeOverrides
    );

    return {
      currentTheme,
      currentThemeOverrides,
      isDark,
    };
  },
};
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--n-background-color);
  color: var(--n-text-color);
}

.n-notification__avatar {
  display: flex;
  align-items: center;
  margin-top: -2px;
}

.n-notification-main__header {
  font-weight: normal !important;
  font-size: 1.1em !important;
  opacity: 0.9;
}

.n-notification-container .n-notification.n-notification--closable .n-notification__close {
  z-index: 1;
}

.n-button {
  background-color: var(--n-color);
}

html.dark body {
  background: rgb(17, 24, 39);
  color: var(--n-text-color);
  min-height: 100vh;
}

</style>
