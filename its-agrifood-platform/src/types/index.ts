// Types for the e-learning platform

export interface Course {
  id: string;
  title: string;
  description: string;
  duration: string;
  instructor: string;
  thumbnail?: string;
  modules: Module[];
}

export interface Module {
  id: string;
  title: string;
  lessons: Lesson[];
}

export interface Lesson {
  id: string;
  title: string;
  duration: string;
  type: 'video' | 'text' | 'quiz';
  completed?: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  enrolledCourses: string[];
  progress: CourseProgress[];
}

export interface CourseProgress {
  courseId: string;
  completedLessons: string[];
  percentage: number;
}
