const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const ngeohash = require('ngeohash');

// Firebase Admin SDK'yı başlat
admin.initializeApp();
const db = admin.firestore();

// --- Yapılandırma ve Sabitler ---
const USER_LOCATION_PRECISION = 9;

const scoringConfig = {
    children: {
        mismatchPenalty: -40,
        sameStatusBonus: 10,
    },
    wantsChildren: {
        similarBonus: 15,
    },
    politicalView: {
        similarBonus: 12,
    },
    education: {
        higherOrSameBonus: { min: 10, max: 15 },
        lowerPenalty: { min: -15, max: -10 },
    },
    religion: {
        similarBonus: 8,
    },
    height: {
        maxBonus: 10,
        minBonus: 5,
    },
    ethnicity: {
        similarBonus: 5,
    },
    workplace: {
        sameBonus: 10,
    },
    profileCompletion: {
        promptsFilledBonus: 5,
        voicePromptBonus: 8,
    },
    substanceUse: {
        mismatchPenalty: -15,
        exactMatchBonus: 10,
        closeMatchBonus: 5,
    },
    hometown: {
        sameBonus: 5,
    },
    interests: {
        perInterestBonus: 10,
        maxBonus: 50,
    }
};

// --- Yardımcı Fonksiyonlar ---
const toRad = (deg) => deg * Math.PI / 180;

function getPrecisionForDistance(distanceKm) {
    if (distanceKm <= 2) return 6;
    if (distanceKm <= 10) return 5;
    if (distanceKm <= 40) return 4;
    if (distanceKm <= 320) return 3;
    return 1;
}

function calculateDistance(loc1, loc2) {
    const R = 6371; // Dünya'nın yarıçapı (km)
    if (!loc1 || !loc2) return Infinity;
    const dLat = toRad(loc2.lat - loc1.lat);
    const dLon = toRad(loc2.lon - loc1.lon);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat))
        * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function checkCompatibility(userA, userB) {
    const prefsA = userA.preferences;
    if (!prefsA || !userB.gender || !userB.age) return false;

    if (!userA.interestedIn || !userA.interestedIn.includes(userB.gender)) return false;
    if (userB.age < prefsA.minAge || userB.age > prefsA.maxAge) return false;
    if (calculateDistance(userA.location, userB.location) > prefsA.maxDistance) return false;

    if (prefsA.drugPolicy === 'never' && userB.usesDrugs) return false;
    if (prefsA.alcoholPolicy === 'never' && userB.alcoholFrequency !== 'never') return false;
    if (prefsA.smokingPolicy === 'never' && userB.smokingFrequency !== 'never') return false;
    return true;
}

function calculateScore(scorer, target) {
    let score = 0;
    const config = scoringConfig;
    if (target.hasChildren && !scorer.hasChildren) { score += config.children.mismatchPenalty; }
    else if (target.hasChildren === scorer.hasChildren) { score += config.children.sameStatusBonus; }
    if (target.wantsChildren === scorer.wantsChildren) { score += config.wantsChildren.similarBonus; }
    if (target.politicalView && target.politicalView === scorer.politicalView) { score += config.politicalView.similarBonus; }
    if (target.educationLevel && scorer.educationLevel) {
        if (target.educationLevel >= scorer.educationLevel) { score += config.education.higherOrSameBonus.max; }
        else { score += config.education.lowerPenalty.min; }
    }
    if (target.religion && target.religion === scorer.religion) { score += config.religion.similarBonus; }
    if (scorer.height && target.height) {
        const heightDiff = Math.abs(scorer.height - target.height);
        if (heightDiff < 5) score += config.height.maxBonus;
        else if (heightDiff < 10) score += config.height.minBonus;
    }
    if (target.ethnicity && target.ethnicity === scorer.ethnicity) { score += config.ethnicity.similarBonus; }
    if (target.workplace && target.workplace === scorer.workplace) { score += config.workplace.sameBonus; }
    if (target.hasCompletedPrompts) score += config.profileCompletion.promptsFilledBonus;
    if (target.hasVoicePrompts) score += config.profileCompletion.voicePromptBonus;
    const substances = ['alcohol', 'smoking', 'marijuana'];
    substances.forEach(substance => {
        const scorerFreq = scorer[`${substance}Frequency`];
        const targetFreq = target[`${substance}Frequency`];
        if (scorerFreq === 'never' && targetFreq !== 'never') { score += config.substanceUse.mismatchPenalty; }
        else if (scorerFreq !== 'never' && targetFreq === 'never') { score += 0; }
        else {
            if (scorerFreq === targetFreq) { score += config.substanceUse.exactMatchBonus; }
            else { score += config.substanceUse.closeMatchBonus; }
        }
    });
    if (target.hometown && target.hometown === scorer.hometown) { score += config.hometown.sameBonus; }
    const commonInterests = (scorer.interests || []).filter(i => (target.interests || []).includes(i));
    const interestScore = Math.min(config.interests.maxBonus, commonInterests.length * config.interests.perInterestBonus);
    score += interestScore;
    return Math.round(Math.max(0, score));
}



// --- Cloud Functions ---

exports.createRandomUsers = onRequest(async (req, res) => {
    try {
        let count = parseInt(req.query.count) || 10;
        if (count > 500) count = 500;
        const allInterests = ['seyahat', 'spor', 'sinema', 'müzik', 'sanat', 'kitap', 'oyun', 'yemek', 'teknoloji'];
        const genders = ['male', 'female'];
        const booleans = [true, false];
        const substanceFreq = ['never', 'socially', 'frequently'];
        const educationLevels = { 'Lise': 1, 'Lisans': 2, 'Yüksek Lisans': 3 };
        const politicalViews = ['Apolitical', 'Liberal', 'Conservative', 'Moderate'];
        const religions = ['Agnostic', 'Atheist', 'Muslim', 'Christian', 'Spiritual'];
        const hometowns = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya'];
        const ethnicities = ['Turkish', 'Kurdish', 'Arab', 'Circassian'];
        const batch = db.batch();
        for (let i = 0; i < count; i++) {
            const lat = Math.random() * (41.2 - 40.9) + 40.9;
            const lon = Math.random() * (29.2 - 28.8) + 28.8;
            const geohash = ngeohash.encode(lat, lon, USER_LOCATION_PRECISION);
            const age = Math.floor(Math.random() * 38) + 18;
            const gender = genders[Math.floor(Math.random() * genders.length)];
            const educationKeys = Object.keys(educationLevels);

            let interestedIn = [];
            const orientationRoll = Math.random();
            if (orientationRoll < 0.85) { // %85 heteroseksüel
                interestedIn.push(gender === 'male' ? 'female' : 'male');
            } else if (orientationRoll < 0.95) { // %10 eşcinsel
                interestedIn.push(gender);
            } else { // %5 biseksüel
                interestedIn = ['male', 'female'];
            }

            const docRef = db.collection('users').doc();
            batch.set(docRef, {
                age, gender, interestedIn, location: { lat, lon }, geohash,
                interests: [...allInterests].sort(() => 0.5 - Math.random()).slice(0, Math.floor(Math.random() * 4) + 2),
                hasChildren: booleans[Math.floor(Math.random() * booleans.length)],
                wantsChildren: booleans[Math.floor(Math.random() * booleans.length)],
                politicalView: politicalViews[Math.floor(Math.random() * politicalViews.length)],
                educationLevel: educationLevels[educationKeys[Math.floor(Math.random() * educationKeys.length)]],
                religion: religions[Math.floor(Math.random() * religions.length)],
                height: Math.floor(Math.random() * 40) + 150,
                ethnicity: ethnicities[Math.floor(Math.random() * ethnicities.length)],
                workplace: `Company ${i % 10}`,
                hometown: hometowns[Math.floor(Math.random() * hometowns.length)],
                hasCompletedPrompts: booleans[Math.floor(Math.random() * booleans.length)],
                hasVoicePrompts: booleans[Math.floor(Math.random() * booleans.length)],
                usesDrugs: booleans[Math.floor(Math.random() * booleans.length)],
                alcoholFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                smokingFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                marijuanaFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                preferences: {
                    minAge: Math.max(18, age - (Math.floor(Math.random() * 5) + 3)),
                    maxAge: age + (Math.floor(Math.random() * 5) + 3),
                    maxDistance: Math.floor(Math.random() * 41) + 10,
                }
            });
        }
        await batch.commit();
        res.status(200).send(`✅ Successfully created ${count} random users with orientation.`);
    } catch (err) {
        console.error("Error creating users:", err);
        res.status(500).send(`Error: ${err.message}`);
    }
});


exports.processMatches = onRequest({ timeoutSeconds: 540, memory: '1GiB' }, async (req, res) => {
    try {
        const today = new Date();
        const dateDocumentId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const dailyMatchCollectionRef = db.collection('matches').doc(dateDocumentId).collection('users');

        const BATCH_SIZE = 200;
        let lastVisible = null;
        let usersProcessed = 0;
        let moreUsersToProcess = true;

        while (moreUsersToProcess) {
            let query = db.collection('users').orderBy('__name__').limit(BATCH_SIZE);
            if (lastVisible) {
                query = query.startAfter(lastVisible);
            }
            const userBatchSnapshot = await query.get();

            if (userBatchSnapshot.empty) {
                moreUsersToProcess = false;
                continue;
            }
            lastVisible = userBatchSnapshot.docs[userBatchSnapshot.docs.length - 1];

            const batchProcessingPromises = userBatchSnapshot.docs.map(async (userDoc) => {
                const uA = { id: userDoc.id, ...userDoc.data() };
                if (!uA.location || !uA.preferences || !uA.interestedIn || uA.interestedIn.length === 0) return;

                const { minAge, maxAge, maxDistance } = uA.preferences;
                const precision = getPrecisionForDistance(maxDistance);
                const centerGeohash = ngeohash.encode(uA.location.lat, uA.location.lon, precision);
                const [start, end] = [centerGeohash, centerGeohash + '~'];

                 let candidatesQuery = db.collection('users')
                    .where('geohash', '>=', start)
                    .where('geohash', '<=', end)
                    .where('age', '>=', minAge)    
                    .where('age', '<=', maxAge)     
                    .where('gender', 'in', uA.interestedIn);


                const candidatesSnapshot = await candidatesQuery.get();
                if (candidatesSnapshot.empty) return;

                let matches = [];
                for (const candidateDoc of candidatesSnapshot.docs) {
                    const uB = { id: candidateDoc.id, ...candidateDoc.data() };
                    if (uA.id === uB.id) continue;

                    // --- Kod-içi Filtreleme ---
                    // Konuma göre gelen adaylar burada yaşa ve diğer uyumluluk kurallarına göre elenir.
                    // Bu, Firestore kısıtlamaları nedeniyle en verimli yöntemdir.
                    if (uB.age >= minAge && uB.age <= maxAge && checkCompatibility(uA, uB) && checkCompatibility(uB, uA)) {
                        const score = calculateScore(uA, uB);
                        if (score > 0) {
                            matches.push({ uuid: uB.id, score });
                        }
                    }
                }

                if (matches.length > 0) {
                    matches.sort((a, b) => b.score - a.score);
                    await dailyMatchCollectionRef.doc(uA.id).set({ matches });
                }
            });

            await Promise.all(batchProcessingPromises);
            usersProcessed += userBatchSnapshot.size;
            console.log(`${usersProcessed} kullanıcı işlendi...`);
        }

        return res.status(200).json({
            status: "success",
            message: `✅ ${usersProcessed} kullanıcı için tercih listeleri optimize edilmiş yöntemle oluşturuldu.`
        });
    } catch (error) {
        console.error("Optimize edilmiş tercih listesi oluşturma hatası:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});


exports.createFinalCouples = onRequest({ timeoutSeconds: 540, memory: '1GiB' }, async (req, res) => {
    try {
        const today = new Date();
        const dateDocumentId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const dailyMatchCollectionRef = db.collection('matches').doc(dateDocumentId).collection('users');

        const allMatchesSnap = await dailyMatchCollectionRef.get();
        if (allMatchesSnap.empty) {
            return res.status(404).json({ status: "error", message: "İşlenecek tercih listesi bulunamadı." });
        }

        const userDocs = await db.collection('users').select('gender', 'interestedIn').get();
        const preferences = new Map();
        allMatchesSnap.docs.forEach(doc => {
            preferences.set(doc.id, (doc.data().matches || []).map(m => m.uuid));
        });

        const heteroMen = new Set();
        const heteroWomen = new Set();
        const gayMen = new Set();
        const lesbianWomen = new Set();

        userDocs.forEach(doc => {
            const userId = doc.id;
            const data = doc.data();
            const gender = data.gender;
            const interestedIn = data.interestedIn || [];

            const isInterestedInMen = interestedIn.includes('male');
            const isInterestedInWomen = interestedIn.includes('female');

            // MVP İÇİN BİSEKSÜEL KULLANICI YÖNETİMİ
            if (isInterestedInMen && isInterestedInWomen) {
                if (gender === 'male') {
                    heteroMen.add(userId);
                } else if (gender === 'female') {
                    heteroWomen.add(userId);
                }
            }
            else {
                if (gender === 'male') {
                    if (isInterestedInWomen) heteroMen.add(userId);
                    if (isInterestedInMen) gayMen.add(userId);
                } else if (gender === 'female') {
                    if (isInterestedInMen) heteroWomen.add(userId);
                    if (isInterestedInWomen) lesbianWomen.add(userId);
                }
            }
        });

        console.log(`Havuzlar (MVP): Hetero Erkek=${heteroMen.size}, Hetero Kadın=${heteroWomen.size}, Gey Erkek=${gayMen.size}, Lezbiyen Kadın=${lesbianWomen.size}`);

        const heteroEngagements = runStableMatching(heteroMen, heteroWomen, preferences);

        const gayMenArray = Array.from(gayMen).sort();
        const gayGroupA = new Set(gayMenArray.slice(0, Math.floor(gayMenArray.length / 2)));
        const gayGroupB = new Set(gayMenArray.slice(Math.floor(gayMenArray.length / 2)));
        const gayEngagements = runStableMatching(gayGroupA, gayGroupB, preferences);

        const lesbianWomenArray = Array.from(lesbianWomen).sort();
        const lesbianGroupA = new Set(lesbianWomenArray.slice(0, Math.floor(lesbianWomenArray.length / 2)));
        const lesbianGroupB = new Set(lesbianWomenArray.slice(Math.floor(lesbianWomenArray.length / 2)));
        const lesbianEngagements = runStableMatching(lesbianGroupA, lesbianGroupB, preferences);

        const finalCouplesMap = {};
        const allEngagements = [heteroEngagements, gayEngagements, lesbianEngagements];

        allEngagements.forEach(engagementMap => {
            for (const [reviewerId, proposerId] of engagementMap.entries()) {
                finalCouplesMap[proposerId] = { partnerId: reviewerId };
                finalCouplesMap[reviewerId] = { partnerId: proposerId };
            }
        });

        const numberOfCouples = Object.keys(finalCouplesMap).length / 2;
        console.log(`Eşleşme tamamlandı. Toplam ${numberOfCouples} çift oluşturuldu.`);

        const couplesDocRef = db.collection('couples').doc(dateDocumentId);
        await couplesDocRef.set({
            couples: finalCouplesMap,
            couplingCompletedAt: new Date().toISOString(),
            totalCouples: numberOfCouples,
            algorithm: "Gale-Shapley (Multi-Pool, MVP-Bisexual-Handling)"
        });

        return res.status(200).json({
            status: "success",
            message: `✅ Başarıyla ${numberOfCouples} stabil çift (çoklu havuz, MVP) oluşturuldu.`,
            dateDocumentId: dateDocumentId,
        });
    } catch (error) {
        console.error("Çoklu havuzlu çift oluşturma hatası:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});


function runStableMatching(proposers, reviewers, allPreferences) {
    const engagements = new Map();
    if (proposers.size === 0 || reviewers.size === 0) return engagements;

    const reviewerRankings = new Map();
    for (const reviewerId of reviewers) {
        const reviewerPrefs = allPreferences.get(reviewerId) || [];
        const rankMap = new Map();
        reviewerPrefs.forEach((proposerId, index) => rankMap.set(proposerId, index));
        reviewerRankings.set(reviewerId, rankMap);
    }

    const freeProposers = Array.from(proposers);
    const proposerClonedPrefs = new Map();
    proposers.forEach(id => proposerClonedPrefs.set(id, [...(allPreferences.get(id) || [])]));

    while (freeProposers.length > 0) {
        const proposerId = freeProposers.shift();
        const proposerPrefs = proposerClonedPrefs.get(proposerId);

        if (proposerPrefs && proposerPrefs.length > 0) {
            const reviewerId = proposerPrefs.shift();

            if (!reviewers.has(reviewerId) || !reviewerRankings.has(reviewerId)) {
                if (proposerPrefs.length > 0) freeProposers.push(proposerId);
                continue;
            }

            const reviewerRankingMap = reviewerRankings.get(reviewerId);
            const currentPartnerId = engagements.get(reviewerId);

            if (!currentPartnerId) {
                engagements.set(reviewerId, proposerId);
            } else {
                const newGuyRank = reviewerRankingMap.get(proposerId);
                const currentGuyRank = reviewerRankingMap.get(currentPartnerId);

                if (newGuyRank !== undefined && (currentGuyRank === undefined || newGuyRank < currentGuyRank)) {
                    engagements.set(reviewerId, proposerId);
                    freeProposers.push(currentPartnerId);
                } else {
                    if (proposerPrefs.length > 0) freeProposers.push(proposerId);
                }
            }
        }
    }
    return engagements;
}