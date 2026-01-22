import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, Trash2, Edit2, Check, X, Zap, Shield, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import api from '@/api/apiClient';

const DAYS = [
  { value: '0', label: 'Sun' },
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
];

const MODES = [
  { value: 'off', label: 'OFF', icon: ShieldOff, color: 'text-red-400 bg-red-500/20' },
  { value: 'safe', label: 'SAFE', icon: Shield, color: 'text-yellow-400 bg-yellow-500/20' },
  { value: 'full', label: 'FULL', icon: Zap, color: 'text-green-400 bg-green-500/20' },
];

const DEFAULT_SCHEDULE = {
  name: '',
  start_time: '09:30',
  end_time: '16:00',
  execution_mode: 'safe',
  days_of_week: '1,2,3,4,5',
  enabled: true,
  priority: 0
};

export default function ScheduleList() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [formData, setFormData] = useState(DEFAULT_SCHEDULE);

  // Fetch schedules
  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: async () => {
      const response = await api.get('/schedules');
      return response.data;
    }
  });

  // Create schedule mutation
  const createMutation = useMutation({
    mutationFn: async (data) => {
      const response = await api.post('/schedules', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Schedule created');
      closeDialog();
    },
    onError: (error) => {
      toast.error(`Failed to create schedule: ${error.response?.data?.error || error.message}`);
    }
  });

  // Update schedule mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      const response = await api.put(`/schedules/${id}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Schedule updated');
      closeDialog();
    },
    onError: (error) => {
      toast.error(`Failed to update schedule: ${error.response?.data?.error || error.message}`);
    }
  });

  // Delete schedule mutation
  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const response = await api.delete(`/schedules/${id}`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Schedule deleted');
    },
    onError: (error) => {
      toast.error(`Failed to delete schedule: ${error.response?.data?.error || error.message}`);
    }
  });

  // Toggle schedule enabled/disabled
  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }) => {
      const response = await api.put(`/schedules/${id}`, { enabled });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      toast.error(`Failed to toggle schedule: ${error.response?.data?.error || error.message}`);
    }
  });

  const openCreateDialog = () => {
    setEditingSchedule(null);
    setFormData(DEFAULT_SCHEDULE);
    setDialogOpen(true);
  };

  const openEditDialog = (schedule) => {
    setEditingSchedule(schedule);
    setFormData({
      name: schedule.name,
      start_time: schedule.start_time,
      end_time: schedule.end_time,
      execution_mode: schedule.execution_mode,
      days_of_week: schedule.days_of_week,
      enabled: schedule.enabled,
      priority: schedule.priority
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingSchedule(null);
    setFormData(DEFAULT_SCHEDULE);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast.error('Schedule name is required');
      return;
    }

    if (editingSchedule) {
      updateMutation.mutate({ id: editingSchedule.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const toggleDay = (dayValue) => {
    const currentDays = formData.days_of_week.split(',').filter(d => d);
    const newDays = currentDays.includes(dayValue)
      ? currentDays.filter(d => d !== dayValue)
      : [...currentDays, dayValue].sort((a, b) => parseInt(a) - parseInt(b));

    setFormData({ ...formData, days_of_week: newDays.join(',') });
  };

  const getModeInfo = (mode) => MODES.find(m => m.value === mode) || MODES[0];

  const formatDays = (daysStr) => {
    const days = daysStr.split(',').map(d => parseInt(d.trim()));
    if (days.length === 7) return 'Every day';
    if (days.join(',') === '1,2,3,4,5') return 'Weekdays';
    if (days.join(',') === '0,6') return 'Weekends';
    return days.map(d => DAYS[d]?.label).join(', ');
  };

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-16 bg-slate-800/50 rounded-lg" />
        <div className="h-16 bg-slate-800/50 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Schedule List */}
      {schedules.length === 0 ? (
        <Card className="bg-slate-800/30 border-slate-700/50">
          <CardContent className="py-8 text-center">
            <Clock className="w-10 h-10 mx-auto text-slate-500 mb-3" />
            <p className="text-sm text-slate-400">No schedules configured</p>
            <p className="text-xs text-slate-500 mt-1">
              Create schedules to automatically switch execution modes
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {schedules.map((schedule) => {
            const modeInfo = getModeInfo(schedule.execution_mode);
            const ModeIcon = modeInfo.icon;

            return (
              <Card
                key={schedule.id}
                className={`bg-slate-800/30 border-slate-700/50 ${!schedule.enabled ? 'opacity-50' : ''}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-center justify-between gap-3">
                    {/* Schedule Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-slate-200 truncate">
                          {schedule.name}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${modeInfo.color}`}>
                          <ModeIcon className="w-3 h-3" />
                          {modeInfo.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
                        <span>{schedule.start_time} - {schedule.end_time}</span>
                        <span className="text-slate-600">|</span>
                        <span>{formatDays(schedule.days_of_week)}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={schedule.enabled}
                        onCheckedChange={(enabled) =>
                          toggleMutation.mutate({ id: schedule.id, enabled })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-slate-400 hover:text-slate-200"
                        onClick={() => openEditDialog(schedule)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-slate-400 hover:text-red-400"
                        onClick={() => {
                          if (confirm(`Delete schedule "${schedule.name}"?`)) {
                            deleteMutation.mutate(schedule.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Button */}
      <Button
        variant="outline"
        className="w-full border-dashed border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500"
        onClick={openCreateDialog}
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Schedule
      </Button>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-200">
              {editingSchedule ? 'Edit Schedule' : 'Create Schedule'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label className="text-slate-300">Name</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Market Open"
                className="bg-slate-800 border-slate-700 text-slate-200"
              />
            </div>

            {/* Time Range */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-slate-300">Start Time</Label>
                <Input
                  type="time"
                  value={formData.start_time}
                  onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                  className="bg-slate-800 border-slate-700 text-slate-200"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">End Time</Label>
                <Input
                  type="time"
                  value={formData.end_time}
                  onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                  className="bg-slate-800 border-slate-700 text-slate-200"
                />
              </div>
            </div>

            {/* Execution Mode */}
            <div className="space-y-2">
              <Label className="text-slate-300">Execution Mode</Label>
              <Select
                value={formData.execution_mode}
                onValueChange={(value) => setFormData({ ...formData, execution_mode: value })}
              >
                <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {MODES.map((mode) => {
                    const Icon = mode.icon;
                    return (
                      <SelectItem key={mode.value} value={mode.value}>
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4" />
                          <span>{mode.label}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Days of Week */}
            <div className="space-y-2">
              <Label className="text-slate-300">Days</Label>
              <div className="flex gap-1">
                {DAYS.map((day) => {
                  const isSelected = formData.days_of_week.split(',').includes(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleDay(day.value)}
                      className={`
                        flex-1 py-2 text-xs font-medium rounded transition-colors
                        ${isSelected
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                          : 'bg-slate-800 text-slate-500 border border-slate-700 hover:border-slate-600'
                        }
                      `}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
              {/* Quick select buttons */}
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, days_of_week: '1,2,3,4,5' })}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Weekdays
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, days_of_week: '0,6' })}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Weekends
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, days_of_week: '0,1,2,3,4,5,6' })}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Every day
                </button>
              </div>
            </div>

            {/* Priority */}
            <div className="space-y-2">
              <Label className="text-slate-300">Priority</Label>
              <Input
                type="number"
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                className="bg-slate-800 border-slate-700 text-slate-200"
                min={0}
                max={100}
              />
              <p className="text-xs text-slate-500">
                Higher priority schedules take precedence when times overlap
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
