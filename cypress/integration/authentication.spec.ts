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

// eslint-disable-next-line jest/no-export
export {};

describe('Authentication', () => {

    const siteUrl = 'https://campus.edu';

    beforeEach(() => {
        cy.interceptSiteRequests(siteUrl);
        cy.visit('/');
    });

    it('Logs in', () => {
        // Skip onboarding.
        cy.see('Welcome to the Moodle App!');
        cy.press('Skip');
        cy.dontSee('Welcome to the Moodle App!');

        // Introduce site url.
        cy.see('Connect to Moodle');
        cy.get('[placeholder="https://campus.example.edu"]').type(siteUrl);
        cy.press('Connect to your site', { force: true });

        // Introduce user credentials.
        cy.see('Log in');
        cy.get('[placeholder="Username"]').type('student', { force: true });
        cy.get('[placeholder="Password"]').type('secret', { force: true });
        cy.contains('ion-button', 'Log in').click();

        // See home.
        cy.see('You are currently using the demo student account of Barbara Gardner');
    });

});
