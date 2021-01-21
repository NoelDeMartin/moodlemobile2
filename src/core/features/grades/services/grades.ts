// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';
import { CoreCourses } from '@features/courses/services/courses';
import { CoreSites } from '@services/sites';
import { CorePushNotifications } from '@features/pushnotifications/services/pushnotifications';
import { makeSingleton } from '@singletons';
import { CoreLogger } from '@singletons/logger';

/**
 * Service to provide grade functionalities.
 */
@Injectable({ providedIn: 'root' })
export class CoreGradesProvider {

    static readonly TYPE_NONE = 0; // Moodle's GRADE_TYPE_NONE.
    static readonly TYPE_VALUE = 1; // Moodle's GRADE_TYPE_VALUE.
    static readonly TYPE_SCALE = 2; // Moodle's GRADE_TYPE_SCALE.
    static readonly TYPE_TEXT = 3; // Moodle's GRADE_TYPE_TEXT.

    protected readonly ROOT_CACHE_KEY = 'mmGrades:';

    protected logger: CoreLogger;

    constructor() {
        this.logger = CoreLogger.getInstance('CoreGradesProvider');
    }

    /**
     * Get cache key for grade table data WS calls.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from.
     * @return Cache key.
     */
    protected getCourseGradesCacheKey(courseId: number, userId: number): string {
        return this.getCourseGradesPrefixCacheKey(courseId) + userId;
    }

    /**
     * Get cache key for grade items data WS calls.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from.
     * @param groupId ID of the group to get the grades from. Default: 0.
     * @return Cache key.
     */
    protected getCourseGradesItemsCacheKey(courseId: number, userId: number, groupId?: number): string {
        groupId = groupId ?? 0;

        return this.getCourseGradesPrefixCacheKey(courseId) + userId + ':' + groupId;
    }

    /**
     * Get prefix cache key for grade table data WS calls.
     *
     * @param courseId ID of the course to get the grades from.
     * @return Cache key.
     */
    protected getCourseGradesPrefixCacheKey(courseId: number): string {
        return this.ROOT_CACHE_KEY + 'items:' + courseId + ':';
    }

    /**
     * Get cache key for courses grade WS calls.
     *
     * @return Cache key.
     */
    protected getCoursesGradesCacheKey(): string {
        return this.ROOT_CACHE_KEY + 'coursesgrades';
    }

    /**
     * Get the grade items for a certain module. Keep in mind that may have more than one item to include outcomes and scales.
     * Fallback function only used if 'gradereport_user_get_grade_items' WS is not avalaible Moodle < 3.2.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from. If not defined use site's current user.
     * @param groupId ID of the group to get the grades from. Not used for old gradebook table.
     * @param siteId Site ID. If not defined, current site.
     * @param ignoreCache True if it should ignore cached data (it will always fail in offline or server down).
     * @return Promise to be resolved when the grades are retrieved.
     */
    async getGradeItems(
        courseId: number,
        userId?: number,
        groupId?: number,
        siteId?: string,
        ignoreCache: boolean = false,
    ): Promise<any> {
        siteId = siteId || CoreSites.instance.getCurrentSiteId();

        const site = await CoreSites.instance.getSite(siteId);

        userId = userId || site.getUserId();

        const enabled = await this.isGradeItemsAvalaible(siteId);

        if (enabled) {
            try {
                const items = await this.getCourseGradesItems(courseId, userId, groupId, siteId, ignoreCache);

                return items;
            } catch (error) {
                // @todo Ignore while solving MDL-57255?
            }
        }

        return this.getCourseGradesTable(courseId, userId, siteId, ignoreCache);
    }

    /**
     * Get the grade items for a certain course.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from.
     * @param groupId ID of the group to get the grades from. Default 0.
     * @param siteId Site ID. If not defined, current site.
     * @param ignoreCache True if it should ignore cached data (it will always fail in offline or server down).
     * @return Promise to be resolved when the grades table is retrieved.
     */
    async getCourseGradesItems(
        courseId: number,
        userId?: number,
        groupId?: number,
        siteId?: string,
        ignoreCache: boolean = false,
    ): Promise<any> {
        const site = await CoreSites.instance.getSite(siteId);

        userId = userId || site.getUserId();
        groupId = groupId || 0;

        this.logger.debug(`Get grades for course '${courseId}' and user '${userId}'`);

        const data = {
            courseid : courseId,
            userid   : userId,
            groupid  : groupId,
        };
        const preSets = {
            cacheKey: this.getCourseGradesItemsCacheKey(courseId, userId, groupId),
        };

        if (ignoreCache) {
            preSets['getFromCache'] = 0;
            preSets['emergencyCache'] = 0;
        }

        const grades = await site.read<CoreGradesGetUserGradeItemsWSResponse>('gradereport_user_get_grade_items', data, preSets);

        if (!grades?.usergrades?.[0]) {
            throw new Error('Couldn\'t get course grades items');
        }

        return grades.usergrades[0].gradeitems;
    }

    /**
     * Get the grades for a certain course.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from.
     * @param siteId Site ID. If not defined, current site.
     * @param ignoreCache True if it should ignore cached data (it will always fail in offline or server down).
     * @return Promise to be resolved when the grades table is retrieved.
     */
    async getCourseGradesTable(courseId: number, userId?: number, siteId?: string, ignoreCache: boolean = false): Promise<any> {
        const site = await CoreSites.instance.getSite(siteId);

        userId = userId || site.getUserId();

        this.logger.debug(`Get grades for course '${courseId}' and user '${userId}'`);

        const data = {
            courseid : courseId,
            userid   : userId,
        };
        const preSets = {
            cacheKey: this.getCourseGradesCacheKey(courseId, userId),
        };

        if (ignoreCache) {
            preSets['getFromCache'] = 0;
            preSets['emergencyCache'] = 0;
        }

        const table = await site.read<CoreGradesGetUserGradesTableWSResponse>('gradereport_user_get_grades_table', data, preSets);

        if (!table?.tables?.[0]) {
            throw new Error('Coudln\'t get course grades table');
        }

        return table.tables[0];
    }

    /**
     * Get the grades for a certain course.
     *
     * @param siteId Site ID. If not defined, current site.
     * @return Promise to be resolved when the grades are retrieved.
     */
    async getCoursesGrades(siteId?: string): Promise<any> {
        const site = await CoreSites.instance.getSite(siteId);

        this.logger.debug('Get course grades');

        const preSets = {
            cacheKey: this.getCoursesGradesCacheKey(),
        };

        const data = await site.read<CoreGradesGetOverviewCourseGradesWSResponse>(
            'gradereport_overview_get_course_grades',
            undefined,
            preSets,
        );

        if (!data?.grades) {
            throw new Error('Couldn\'t get course grades');
        }

        return data.grades;
    }

    /**
     * Invalidates courses grade table and items WS calls for all users.
     *
     * @param courseId ID of the course to get the grades from.
     * @param siteId Site ID (empty for current site).
     * @return Promise resolved when the data is invalidated.
     */
    invalidateAllCourseGradesData(courseId: number, siteId?: string): Promise<void> {
        return CoreSites.instance.getSite(siteId)
            .then((site) => site.invalidateWsCacheForKeyStartingWith(this.getCourseGradesPrefixCacheKey(courseId)));
    }

    /**
     * Invalidates grade table data WS calls.
     *
     * @param courseId Course ID.
     * @param userId User ID.
     * @param siteId Site id (empty for current site).
     * @return Promise resolved when the data is invalidated.
     */
    invalidateCourseGradesData(courseId: number, userId?: number, siteId?: string): Promise<void> {
        return CoreSites.instance.getSite(siteId).then((site) => {
            userId = userId || site.getUserId();

            return site.invalidateWsCacheForKey(this.getCourseGradesCacheKey(courseId, userId));
        });
    }

    /**
     * Invalidates courses grade data WS calls.
     *
     * @param siteId Site id (empty for current site).
     * @return Promise resolved when the data is invalidated.
     */
    invalidateCoursesGradesData(siteId?: string): Promise<void> {
        return CoreSites.instance.getSite(siteId).then((site) => site.invalidateWsCacheForKey(this.getCoursesGradesCacheKey()));
    }

    /**
     * Invalidates courses grade items data WS calls.
     *
     * @param courseId ID of the course to get the grades from.
     * @param userId ID of the user to get the grades from.
     * @param groupId ID of the group to get the grades from. Default: 0.
     * @param siteId Site id (empty for current site).
     * @return Promise resolved when the data is invalidated.
     */
    invalidateCourseGradesItemsData(courseId: number, userId: number, groupId?: number, siteId?: string): Promise<void> {
        return CoreSites.instance.getSite(siteId)
            .then((site) => site.invalidateWsCacheForKey(this.getCourseGradesItemsCacheKey(courseId, userId, groupId)));
    }

    /**
     * Returns whether or not the plugin is enabled for a certain site.
     *
     * @param siteId Site ID. If not defined, current site.
     * @return Resolve with true if plugin is enabled, false otherwise.
     * @since  Moodle 3.2
     */
    isCourseGradesEnabled(siteId?: string): Promise<boolean> {
        return CoreSites.instance.getSite(siteId).then((site) => {
            if (!site.wsAvailable('gradereport_overview_get_course_grades')) {
                return false;
            }
            // Now check that the configurable mygradesurl is pointing to the gradereport_overview plugin.
            const url = site.getStoredConfig('mygradesurl') || '';

            return url.indexOf('/grade/report/overview/') !== -1;
        });
    }

    /**
     * Returns whether or not the grade addon is enabled for a certain course.
     *
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved with true if plugin is enabled, rejected or resolved with false otherwise.
     */
    isPluginEnabledForCourse(courseId: number, siteId?: string): Promise<boolean> {
        if (!courseId) {
            return Promise.reject(null);
        }

        return CoreCourses.instance.getUserCourse(courseId, true, siteId)
            .then((course) => !(course && typeof course.showgrades != 'undefined' && !course.showgrades));
    }

    /**
     * Returns whether or not WS Grade Items is avalaible.
     *
     * @param siteId Site ID. If not defined, current site.
     * @return True if ws is avalaible, false otherwise.
     * @since  Moodle 3.2
     */
    isGradeItemsAvalaible(siteId?: string): Promise<boolean> {
        return CoreSites.instance.getSite(siteId).then((site) => site.wsAvailable('gradereport_user_get_grade_items'));
    }

    /**
     * Log Course grades view in Moodle.
     *
     * @param courseId Course ID.
     * @param userId User ID.
     * @param name Course name. If not set, it will be calculated.
     * @return Promise resolved when done.
     */
    async logCourseGradesView(courseId: number, userId: number, name?: string): Promise<void> {
        userId = userId || CoreSites.instance.getCurrentSiteUserId();

        const wsName = 'gradereport_user_view_grade_report';

        if (!name) {
            // eslint-disable-next-line promise/catch-or-return
            CoreCourses.instance.getUserCourse(courseId, true)
                .catch(() => ({}))
                .then(course => CorePushNotifications.instance.logViewEvent(
                    courseId,
                    'fullname' in course ? course.fullname : '',
                    'grades',
                    wsName,
                    { userid: userId },
                ));
        } else {
            CorePushNotifications.instance.logViewEvent(courseId, name, 'grades', wsName, { userid: userId });
        }

        const site = await CoreSites.instance.getCurrentSite();

        await site?.write(wsName, { courseid: courseId, userid: userId });
    }

    /**
     * Log Courses grades view in Moodle.
     *
     * @param courseId Course ID. If not defined, site Home ID.
     * @return Promise resolved when done.
     */
    async logCoursesGradesView(courseId?: number): Promise<void> {
        if (!courseId) {
            courseId = CoreSites.instance.getCurrentSiteHomeId();
        }

        const params = {
            courseid: courseId,
        };

        CorePushNotifications.instance.logViewListEvent('grades', 'gradereport_overview_view_grade_report', params);

        const site = await CoreSites.instance.getCurrentSite();

        await site?.write('gradereport_overview_view_grade_report', params);
    }

}

export class CoreGrades extends makeSingleton(CoreGradesProvider) {}

/**
 * Data returned by gradereport_user_get_grade_items WS.
 */
export type CoreGradesGetUserGradeItemsWSResponse = {
    usergrades: any[];
};

/**
 * Data returned by gradereport_user_get_grades_table WS.
 */
export type CoreGradesGetUserGradesTableWSResponse = {
    tables: any[];
};

/**
 * Data returned by gradereport_overview_get_course_grades WS.
 */
export type CoreGradesGetOverviewCourseGradesWSResponse = {
    grades: any[];
};
