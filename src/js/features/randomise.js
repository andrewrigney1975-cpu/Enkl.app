"use strict";
import { getCurrentProject } from '../store.js';
import { toast } from '../ui.js';
import { confirmDialog } from '../modals/confirm.js';
import { saveDB } from '../storage.js';
import { getTasksArray } from '../utils.js';
import { reactivateTasks, moveTaskToColumn } from '../mutations.js';
import { renderAll } from '../views/board.js';
import { localDateValueFromDate, localDateValueToUTCISO, clampTaskScore } from '../date-utils.js';

var DAY_MS = 24 * 60 * 60 * 1000;

function randomInt(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr){
  for(var i = arr.length - 1; i > 0; i--){
    var j = randomInt(0, i);
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

function randomDateWithinProject(project){
  var start = project.startDate ? new Date(project.startDate).getTime() : null;
  var end = project.endDate ? new Date(project.endDate).getTime() : null;
  if(start == null && end == null){
    start = Date.now();
    end = start + 90 * DAY_MS;
  } else if(start == null){
    start = end - 90 * DAY_MS;
  } else if(end == null){
    end = start + 90 * DAY_MS;
  }
  if(end < start){ var tmp = start; start = end; end = tmp; }
  var t = start + Math.random() * (end - start);
  return localDateValueToUTCISO(localDateValueFromDate(new Date(t)));
}

function applyRandomisation(project){
  var tasks = getTasksArray(project);
  if(tasks.length === 0){ toast('This project has no tasks to randomise.'); return; }

  var archivedIds = tasks.filter(function(t){ return t.archived; }).map(function(t){ return t.id; });
  if(archivedIds.length > 0) reactivateTasks(project, archivedIds);

  var columns = project.columns || [];
  var members = project.members || [];
  var allTaskIds = tasks.map(function(t){ return t.id; });

  tasks.forEach(function(t){
    if(columns.length > 0){
      var col = columns[randomInt(0, columns.length - 1)];
      moveTaskToColumn(project, t.id, col.id, -1);
    }

    t.assigneeId = members.length > 0 ? members[randomInt(0, members.length - 1)].id : null;

    var candidates = shuffle(allTaskIds.filter(function(id){ return id !== t.id; }));
    var relateCount = Math.min(randomInt(1, 3), candidates.length);
    t.dependencies = candidates.slice(0, relateCount);

    t.businessValue = clampTaskScore(randomInt(100, 800));
    t.taskCost = clampTaskScore(randomInt(200, 600));

    var d1 = randomDateWithinProject(project);
    var d2 = randomDateWithinProject(project);
    if(d1 && d2 && new Date(d1).getTime() > new Date(d2).getTime()){
      var swap = d1; d1 = d2; d2 = swap;
    }
    t.startDate = d1;
    t.endDate = d2;

    t.dateLastModified = new Date().toISOString();
  });

  saveDB();
  renderAll();
  toast('Randomised ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + '.');
}

export function randomise(){
  var project = getCurrentProject();
  if(!project){ toast('No project selected.'); return; }

  confirmDialog(
    'Randomise this project?',
    'This will irreversibly overwrite every task in "' + project.key + '": unarchiving all tasks and randomising their column, assignee, related tasks, business value, cost, and start/end dates. Back up this project first if you want to keep the current data.',
    function(){ applyRandomisation(project); }
  );
}
