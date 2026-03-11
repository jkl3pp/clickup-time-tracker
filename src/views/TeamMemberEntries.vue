<template>

  <member-selector :open="true" :active="$route.params.userId" />

  <!-- START | Calendar view -->
  <vue-cal
    :editable-events="false"
    :hide-weekends="false"
    :disable-views="['years', 'year', 'month', 'day']"
    :click-to-navigate="false"
    :hide-view-selector="true"
    :watch-real-time="true"
    :time-cell-height="90"
    :time-from="6 * 60"
    :time-to="24 * 60"
    :events="events"
    @ready="fetchEvents"
    @view-change="fetchEvents"
    @keydown.meta.x.exact="refreshBackgroundImage()"
    active-view="week"
    today-button
    class="mt-[80px] bg-gray-50 text-gray-900 dark:bg-gray-800 dark:text-gray-300"
    ref="calendar"
  >
    <template v-slot:title="{ title }">
      <div class="flex items-center space-x-4">
        <span aria-label="false" type="false">
          {{ title }}
          <template v-if="events.length > 0">
            <clock-icon class="w-3 ml-3 -mt-0.5 inline-block dark:text-gray-400"/>
            <span class="italic text-xs dark:text-gray-400">{{ totalHoursOnDate(events) }}</span>
          </template>
        </span>

        <!-- START | Extra controls -->
        <div
          class="flex space-x-1 text-gray-600 dark:text-gray-400"
          style="-webkit-app-region: no-drag"
        >
          <router-link :to="{ name: 'settings' }" replace class="hover:text-gray-800 dark:hover:text-gray-100">
            <cog-icon class="w-5" />
          </router-link>

          <router-link :to="{ name: 'time-tracker' }" replace class="hover:text-gray-800 dark:hover:text-gray-100">
            <user-icon class="w-5" />
          </router-link>
        </div>
        <!-- End | Extra controls -->
      </div>
    </template>

    <!-- START | Custom Day heading -->
    <template v-slot:weekday-heading="{ heading, view }">
        <div class="flex flex-col justify-center sm:flex-row">

            <div>
                <span class="full">{{ heading.label }}</span>
                <span class="small">{{ heading.date.toLocaleDateString('en-US', { weekday: 'short' }) }}</span>
                <span class="xsmall">{{ heading.label[0] }}</span>
                <span>&nbsp;{{ heading.date.toLocaleDateString('en-US', { day: 'numeric' }) }}</span>
            </div>

            <div
                v-if="hasTimeTrackedOn(heading.date, view.events)"
                class="inline-flex items-center ml-2 text-xs text-gray-600 space-x-[2px] dark:text-gray-400"
            >
                <clock-icon class="w-3 -mt-0.5" />
                <span class="italic">{{ totalHoursOnDate(view.events, heading.date) }}</span>
            </div>

        </div>
    </template>
    <!-- END | Custom Day heading -->

    <template v-slot:event="{ event }" >

        <div class="vuecal__event-title">
            <span class="dark:text-gray-100">
                {{ event.title }}
                <span v-if="event.taskLocationShort" class="block text-xs text-gray-500 dark:text-gray-400 font-normal">{{ event.taskLocationShort }}</span>
            </span>

            <!-- START | Task context popover -->
            <n-popover trigger="hover" :delay="500" :duration="60" width="260">

                <template #trigger>
                    <span class="vuecal__event-task-info-popover absolute top-0 right-0 py-0.5 px-1 cursor-pointer">
                        <information-circle-icon class="w-5 transition-all hover:scale-125 dark:text-gray-400"/>
                    </span>
                </template>

                <template #header>
                    <span class="font-semibold text-gray-700 dark:text-gray-200">
                        {{ event.title }}
                        <span v-if="event.taskLocationShort" class="block text-xs text-gray-500 dark:text-gray-400 font-normal">{{ event.taskLocationShort }}</span>
                    </span>
                </template>

                <span v-text="event.description" class="whitespace-pre-wrap text-gray-700 dark:text-gray-200"></span>

                <hr class="my-2 -mx-3.5 border-gray-200 dark:border-gray-700" />

                <button v-if="event.taskUrl" @click="shell.openExternal(event.taskUrl)" class="flex items-center py-1 space-x-1 italic text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-100">
                    <img class="mt-1 w-7" src="@/assets/images/white-rounded-logo.svg" alt="Open task in ClickUp">
                    <span>Open in ClickUp</span>
                </button>

                <button @click="onTaskDoubleClick(event)" class="flex items-center py-1 space-x-1 italic text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-100">
                    <pencil-icon class="w-4 mx-1.5" />
                    <span>Open details</span>
                </button>

            </n-popover>
            <!-- END | Task context popover -->

        </div>

        <!-- START | Time from/to -->
        <div v-if="store.get('settings.show_start_end_time') !== false || store.get('settings.show_duration') !== false"
          class="vuecal__event-time flex justify-between dark:text-gray-400">
          <span v-if="store.get('settings.show_start_end_time') !== false">{{ event.start.formatTime('HH:mm') }}<span class="opacity-40">…</span>{{ event.end.formatTime('HH:mm') }}</span>
          <span v-if="store.get('settings.show_duration') !== false">{{ formatDuration(event.end - event.start) }}</span>
        </div>
        <!-- END | Time from/to -->

    </template>

  </vue-cal>
  <!-- END | Calendar view -->

  <!-- START | Task detail modal -->
  <n-modal v-model:show="showTaskDetailsModal">
    <n-card
      :bordered="false"
      class="max-w-xl"
      size="huge"
      role="dialog"
      aria-modal="true"
    >
      <template #header>
        <span class="font-semibold text-gray-700 dark:text-gray-200">
          {{ selectedTask.title }}
          <span v-if="selectedTask.taskLocationShort" class="block text-xs text-gray-500 dark:text-gray-400 font-normal">{{ selectedTask.taskLocationShort }}</span>
        </span>
      </template>
      <n-space vertical>

        <p class="whitespace-pre-wrap">{{ selectedTask.description || "No description provided" }}</p>

      </n-space>
    </n-card>
  </n-modal>
  <!-- END | Task detail modal -->
</template>


<script>
import { ref, watch } from "vue";
import { RouterLink } from "vue-router";
const shell = require('electron').shell;

import VueCal from "vue-cal";
import "@/assets/vuecal.scss";

import store from "@/store";
import eventFactory from "@/events-factory";
import clickupService from "@/clickup-service";

import { InformationCircleIcon, CogIcon, UserIcon } from "@heroicons/vue/20/solid";
import { ClockIcon, PencilIcon } from "@heroicons/vue/24/outline";
import { NModal,  NCard,  NSpace, NPopover,  useNotification } from "naive-ui";
import MemberSelector from '@/components/MemberSelector'
import { totalHoursOnDate as totalHoursOnDateUtil, hasTimeTrackedOn as hasTimeTrackedOnUtil, formatDuration } from '@/utils/time-utils'

export default {
  components: { MemberSelector, VueCal, RouterLink, NModal, NCard, NSpace, NPopover, CogIcon, UserIcon, ClockIcon, PencilIcon, InformationCircleIcon },

  setup() {
    const notification = useNotification();

    return {
      shell,
      store,

      events: ref([]),
      selectedTask: ref({}),

      clickupCards: ref([]),
      loadingClickupCards: ref(false),

      showTaskDetailsModal: ref(false),
      totalHoursOnDate: totalHoursOnDateUtil,
      hasTimeTrackedOn: hasTimeTrackedOnUtil,
      formatDuration,

      error(options) {
        notification.error({ duration: 5000, ...options });

        if (options.error) {
          console.error(options.error);
        }
      },
    };
  },

  mounted() {
    watch(() => this.$route.params.userId, () => {

        const startDate = this.$refs.calendar.$data.view.startDate
        const endDate = this.$refs.calendar.$data.view.endDate

        this.events = []
        this.fetchEvents({ startDate, endDate })
      }
    )

    // Load background image if set
    this.refreshBackgroundImage();
  },

  methods: {
    /*
    |--------------------------------------------------------------------------
    | FETCH TIME TRACKING ENTRIES
    |--------------------------------------------------------------------------
    */
    async fetchEvents({ startDate, endDate }) {
      clickupService
        .getTimeTrackingRange(startDate, endDate, this.$route.params.userId)
        .then(entries => {
          this.events = entries
            .map((entry) => eventFactory.fromClickup(entry)) // Map into Event DTO
            .filter((entry) => entry); // Remove falsey entries
        })
        .catch(error => {
            if(error === 'You have no access') {
                this.error({
                    error,
                    title: "You don't have access",
                    content: "You need to be the workspace administrator in order to see other people's tracking entries",
                })

                return this.$router.replace({ name: 'settings' })
            }

            this.error({
                error,
                title: "Could not fetch time tracking entries",
                content: "Check your console & internet connection and try again",
            })
        });
    },

    /*
    |--------------------------------------------------------------------------
    | SELECTING A TASK & DISPLAY DETAIL MODAL
    |--------------------------------------------------------------------------
    */
    onTaskSingleClick(event, e) {
      this.selectedTask = event;
      e.stopPropagation();
    },

    onTaskDoubleClick(event, e) {
      this.selectedTask = event;

      this.showTaskDetailsModal = true;
      e.stopPropagation();
    },

    closeDetailModal() {
      this.showTaskDetailsModal = false;
    },

    /*
    |--------------------------------------------------------------------------
    | MISC & EASTER EGG LAND
    |--------------------------------------------------------------------------
    */
    refreshBackgroundImage: function() {

      const bg = document.getElementsByClassName('vuecal')[0];
      const url = store.get("settings.background_image_url")
      if(!url) return

      bg.style.backgroundImage = `url('${url}?${Math.random()}')`;
      bg.style.backgroundRepeat = "no-repeat";
      bg.style.backgroundPosition = "center";
      bg.style.backgroundSize = "cover";
    }
  }
};
</script>
