<script setup>
import { ref, watch, watchEffect } from "vue"
import clickupService from "@/clickup-service";
import { ArcElement, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Title, Tooltip } from 'chart.js'
import { Bar, Doughnut } from 'vue-chartjs'
import store from "@/store";
import GoalGraph from "@/components/GoalGraph.vue";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement)
ChartJS.defaults.font.family = 'Avenir, Helvetica, Arial, sans-serif'

const props = defineProps({
  open: Boolean,
  events: Array,
  start_date: Date,
  end_date: Date
})

let loading = ref(false);
let goals = store.get("settings.goals")
let goalsEnabled = store.get("settings.enable_goals") !== false

// Days of week chart
let daysOfWeekChartData = ref({ datasets: [] });
let daysOfWeekChartOptions = ref({
  plugins: {
    title: {
      display: false,
    },
  },
  maintainAspectRatio: false,
  responsive: true,
  barPercentage: 1.0,
  categoryPercentage: 1.0,
  scales: {
    x: {
      stacked: true,
    },
    y: {
      stacked: true
    }
  }
})
let daysOfWeekChartStyles = ref({
  position: 'relative',
  width: '100%',
  height: '225px'
})

// Week chart
let weekChartData = ref({ datasets: [] });
let weekChartOptions = ref({
  responsive: true,
  maintainAspectRatio: true,
  plugins: {
    legend: {
      display: false
    },
  }
})
let weekChartStyles = ref({
  position: 'relative',
  height: '225px'
})
let weekChartPlugins = {
  afterDraw: (chart) => {
    let ctx = chart.ctx;
    if (chart.data.datasets.length === 0) return;
    let totalHours = Math.round(chart.data.datasets[0].data.reduce((a, b) => a + b, 0));
    let txtX = Math.round((chart.width - ctx.measureText(totalHours).width) / 2);
    let txtY = Math.round((chart.height + 35) / 2);
    ctx.font = '60px Avenir, Helvetica, Arial, sans-serif';
    ctx.fillText(totalHours, txtX, txtY);
  }
};

watch(() => props.open, open => {
  const vueCalRoots = document.getElementsByClassName('vuecal')
  if (!vueCalRoots.length) return;
  if (open) {
    return vueCalRoots[0].classList.add('vuecal--time-tracking-statistics-open')
  }
  return vueCalRoots[0].classList.remove('vuecal--time-tracking-statistics-open')
})

watchEffect(async () => {
  if (props.open && props.events.length && props.start_date && props.end_date) {
    console.log(props)
    loading.value = true
    await onCreate()
    loading.value = false
  }
});

async function onCreate() {

  clickupService.getSpaces().then(spaces => {
    buildEventsData(props.events, spaces)
  })
}

async function buildEventsData(events, spaces) {
  await Promise.all(events.map(async event => {
    let foundSpace = spaces.find(space => space.id === event.spaceId);
    const baseColor = (foundSpace && foundSpace.color) ? foundSpace.color : "#ADD8E6"
    return {
      spaceName: (foundSpace) ? foundSpace.name : "Unknown space",
      color: baseColor + '59',
      colorSolid: baseColor,
      startDate: new Date(event.start).toLocaleDateString('en-CA'),
      endDate: new Date(event.end).toLocaleDateString('en-CA'),
      durationInHours: (new Date(event.end) - new Date(event.start)) / 3600000
    }
  })).then(processedEvents => {
    buildDaysOfWeekChart(processedEvents)
    buildWeekChart(processedEvents)
  }).catch(error => {
    console.error(error)
  })
}

// Build days of week chart data
async function buildDaysOfWeekChart(processedEvents) {
  let date = new Date(props.start_date)
  let dates = []
  while (date <= props.end_date) {
    let dateString = date.toLocaleDateString('en-CA')
    if (!dates.includes(dateString)) {
      dates.push(dateString)
    }
    date.setUTCDate(date.getUTCDate() + 1)
    date.setUTCHours(1)
  }
  let uniqueSpaces = [...new Set(processedEvents.map(event => event.spaceName))]
  daysOfWeekChartData.value = {
    labels: dates,
    datasets: uniqueSpaces.map(space => {
      let spaceEvents = processedEvents.filter(event => event.spaceName === space)
      let spaceEventsDuration = dates.map(date => {
        let dateEvents = spaceEvents.filter(event => event.startDate === date)
        return dateEvents.reduce((accumulator, currentValue) => accumulator + currentValue.durationInHours, 0)
      })
      return {
        label: space,
        backgroundColor: spaceEvents[0].color,
        borderColor: spaceEvents[0].colorSolid,
        borderWidth: { left: 4, top: 0, right: 0, bottom: 0 },
        borderSkipped: false,
        data: spaceEventsDuration
      }
    })
  }
}


// Week chart
// TODO: The week doughnut chart is not being emptied when the week changes, so the totals keep adding up.
async function buildWeekChart(processedEvents) {
  const groupedEvents = processedEvents.reduce((acc, event) => {
    if (!acc[event.spaceName]) {
      acc[event.spaceName] = 0
    }
    acc[event.spaceName] += event.durationInHours;
    return acc;
  }, {});

  let colors = []
  let solidColors = []
  for (let spaceGroupedEvent in groupedEvents) {
    let foundSpace = processedEvents.find(event => event.spaceName === spaceGroupedEvent)
    colors.push(foundSpace.color)
    solidColors.push(foundSpace.colorSolid)
  }

  weekChartData.value = {
    labels: Object.keys(groupedEvents),
    datasets: [{
      data: Object.values(groupedEvents),
      backgroundColor: colors,
      borderColor: solidColors,
      borderWidth: 3
    }]
  }
}


</script>

<template>
  <Transition name="time-tracking-statistics">
    <div v-show="open"
      class="time-tracking-statistics select-none bg-gray-50 dark:bg-gray-800 flex fixed top-0 inset-x-0 z-10 shadow-inner h-[500px]">
      <!-- TODO: Implement this -->
      <!-- START: Loading state -->
      <div v-if="loading" class="flex justify-center items-center h-full w-full">
        <img class="animate-pulse w-30 h-30" src="@/assets/images/wave.gif" alt="Wave animation">
      </div>

      <!-- START: Empty state -->
      <div v-if="!loading && !events.length" class="self-center w-full text-center">
        Looks like no data could be found for week.
      </div>


      <div v-if="!loading && events.length" class="self-center w-full text-center">
        <div
          class="items-end h-full w-full pl-3 pb-1 overflow-x-scroll align-text-top grid grid-rows-2 gap-1 statistics-container">
          <div class="grid grid-cols-3 gap-4">
            <div class="chart-container">
              <Doughnut :data="weekChartData" :options="weekChartOptions" :style="weekChartStyles"
                :plugins="[weekChartPlugins]" />
            </div>
            <div v-if="goalsEnabled"
              class="col-span-2 chart-container bg-gray-50 dark:bg-gray-800 border rounded-lg shadow-sm mr-2.5">
              <label class="absolute bg-gray-50 dark:bg-gray-800 px-1.5 -left-0.5 -top-3">Goals</label>
              <GoalGraph v-for="(goal, index) in goals" :key="index" :goal="goal" :start_date="props.start_date"
                :end_date="props.end_date" />
            </div>
          </div>
          <div class="">
            <Bar :data="daysOfWeekChartData" :options="daysOfWeekChartOptions" :style="daysOfWeekChartStyles" />
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
.time-tracking-statistics {
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  -webkit-app-region: drag;
}

/* Time tracking statistics transition */
/*
  This uses are used by the <Transition> component.
  Might appear to be unused, but they are not.
 */
.time-tracking-statistics-enter-active {
  transition: all 0.2s ease;
}

.time-tracking-statistics-leave-active {
  /* transition: all 0.2s ease; */
}

.time-tracking-statistics-enter-from,
.time-tracking-statistics-leave-to {
  top: -500px;
  opacity: 0;
}

.chart-container {
  position: relative;
  height: 210px;
  display: flex;
  justify-content: center;
  align-items: center;
}

/* VueCal top margin transition */
.vuecal {
  transition: all 0.2s ease;
}

.vuecal.vuecal--time-tracking-statistics-open {
  margin-top: 500px;
}

/* Hide scrollbar */
.statistics-container::-webkit-scrollbar {
  display: none;
}
</style>