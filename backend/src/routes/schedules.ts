import express, { Request, Response } from 'express';
import { prisma } from '../index';
import { triggerModeCheck } from '../services/modeScheduler';

const router = express.Router();

// Get all schedules
router.get('/', async (req: Request, res: Response) => {
  try {
    const schedules = await prisma.executionSchedule.findMany({
      orderBy: [
        { priority: 'desc' },
        { start_time: 'asc' }
      ]
    });

    res.json(schedules);
  } catch (error: any) {
    console.error('Error fetching schedules:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single schedule
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const schedule = await prisma.executionSchedule.findUnique({
      where: { id: req.params.id }
    });

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json(schedule);
  } catch (error: any) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new schedule
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name,
      start_time,
      end_time,
      execution_mode,
      days_of_week,
      enabled = true,
      priority = 0
    } = req.body;

    // Validate required fields
    if (!name || !start_time || !end_time || !execution_mode || !days_of_week) {
      return res.status(400).json({
        error: 'Missing required fields: name, start_time, end_time, execution_mode, days_of_week'
      });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(start_time) || !timeRegex.test(end_time)) {
      return res.status(400).json({
        error: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    // Validate execution_mode
    if (!['off', 'safe', 'full'].includes(execution_mode)) {
      return res.status(400).json({
        error: 'Invalid execution_mode. Must be: off, safe, or full'
      });
    }

    // Validate days_of_week format
    const daysArray = days_of_week.split(',').map((d: string) => parseInt(d.trim()));
    if (daysArray.some((d: number) => isNaN(d) || d < 0 || d > 6)) {
      return res.status(400).json({
        error: 'Invalid days_of_week. Use comma-separated numbers 0-6 (0=Sunday, 6=Saturday)'
      });
    }

    const schedule = await prisma.executionSchedule.create({
      data: {
        name,
        start_time,
        end_time,
        execution_mode,
        days_of_week,
        enabled,
        priority
      }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: 'schedule_created',
        ticker: null,
        details: JSON.stringify(schedule)
      }
    });

    // Trigger immediate mode check in case new schedule applies now
    await triggerModeCheck();

    console.log(`📅 Created schedule: ${name} (${start_time}-${end_time} → ${execution_mode})`);

    res.status(201).json(schedule);
  } catch (error: any) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a schedule
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      start_time,
      end_time,
      execution_mode,
      days_of_week,
      enabled,
      priority
    } = req.body;

    // Build update data with only provided fields
    const updateData: any = {};

    if (name !== undefined) updateData.name = name;
    if (start_time !== undefined) {
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(start_time)) {
        return res.status(400).json({ error: 'Invalid start_time format. Use HH:MM' });
      }
      updateData.start_time = start_time;
    }
    if (end_time !== undefined) {
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(end_time)) {
        return res.status(400).json({ error: 'Invalid end_time format. Use HH:MM' });
      }
      updateData.end_time = end_time;
    }
    if (execution_mode !== undefined) {
      if (!['off', 'safe', 'full'].includes(execution_mode)) {
        return res.status(400).json({ error: 'Invalid execution_mode. Must be: off, safe, or full' });
      }
      updateData.execution_mode = execution_mode;
    }
    if (days_of_week !== undefined) {
      const daysArray = days_of_week.split(',').map((d: string) => parseInt(d.trim()));
      if (daysArray.some((d: number) => isNaN(d) || d < 0 || d > 6)) {
        return res.status(400).json({ error: 'Invalid days_of_week format' });
      }
      updateData.days_of_week = days_of_week;
    }
    if (enabled !== undefined) updateData.enabled = enabled;
    if (priority !== undefined) updateData.priority = priority;

    const schedule = await prisma.executionSchedule.update({
      where: { id },
      data: updateData
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: 'schedule_updated',
        ticker: null,
        details: JSON.stringify({ id, changes: updateData })
      }
    });

    // Trigger immediate mode check in case update affects current mode
    await triggerModeCheck();

    console.log(`📅 Updated schedule: ${schedule.name}`);

    res.json(schedule);
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a schedule
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const schedule = await prisma.executionSchedule.delete({
      where: { id }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        event_type: 'schedule_deleted',
        ticker: null,
        details: JSON.stringify({ id, name: schedule.name })
      }
    });

    // Trigger immediate mode check in case deletion affects current mode
    await triggerModeCheck();

    console.log(`📅 Deleted schedule: ${schedule.name}`);

    res.json({ success: true, deleted: schedule });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger mode check (useful for testing)
router.post('/check-now', async (req: Request, res: Response) => {
  try {
    await triggerModeCheck();

    const settings = await prisma.executionSettings.findFirst();

    res.json({
      success: true,
      message: 'Mode check completed',
      current_mode: settings?.execution_mode
    });
  } catch (error: any) {
    console.error('Error triggering mode check:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
