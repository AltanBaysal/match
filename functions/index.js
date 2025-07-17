// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const ngeohash = require('ngeohash');

admin.initializeApp();
const db = admin.firestore();

// --- Configuration ---
const USER_LOCATION_PRECISION = 9;

const scoringConfig = {
    // ... (Bu kısım hiç değiştirilmedi, olduğu gibi doğru) ...
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

// --- Helper Functions --- (Değişiklik yok)
const toRad = (deg) => deg * Math.PI / 180;

function getPrecisionForDistance(distanceKm) {
    if (distanceKm <= 2) return 6;
    if (distanceKm <= 10) return 5;
    if (distanceKm <= 40) return 4;
    if (distanceKm <= 320) return 3;
    return 1;
}

function calculateDistance(loc1, loc2) {
    const R = 6371;
    const dLat = toRad(loc2.lat - loc1.lat);
    const dLon = toRad(loc2.lon - loc1.lon);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat))
        * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getBoundingBox(latitude, longitude, distanceKm) {
    const R = 6371;
    const latRad = toRad(latitude);
    const latDelta = distanceKm / R;
    const lonDelta = distanceKm / (R * Math.cos(latRad));
    const minLat = latitude - latDelta * (180 / Math.PI);
    const maxLat = latitude + latDelta * (180 / Math.PI);
    const minLon = longitude - lonDelta * (180 / Math.PI);
    const maxLon = longitude + lonDelta * (180 / Math.PI);
    return { minLat, minLon, maxLat, maxLon };
}

function checkCompatibility(userA, userB) {
    const prefsA = userA.preferences;
    if (prefsA.gender !== userB.gender) return false;
    if (userB.age < prefsA.minAge || userB.age > prefsA.maxAge) return false;
    const distance = calculateDistance(userA.location, userB.location);
    if (distance > prefsA.maxDistance) return false;
    if (prefsA.drugPolicy === 'never' && userB.usesDrugs) return false;
    if (prefsA.alcoholPolicy === 'never' && userB.alcoholFrequency !== 'never') return false;
    if (prefsA.smokingPolicy === 'never' && userB.smokingFrequency !== 'never') return false;
    return true;
}

function calculateScore(scorer, target) {
    // ... (Bu kısım hiç değiştirilmedi, olduğu gibi doğru) ...
    let score = 0;
    const config = scoringConfig;
    if (target.hasChildren && !scorer.hasChildren) {
        score += config.children.mismatchPenalty;
    } else if (target.hasChildren === scorer.hasChildren) {
        score += config.children.sameStatusBonus;
    }
    if (target.wantsChildren === scorer.wantsChildren) {
        score += config.wantsChildren.similarBonus;
    }
    if (target.politicalView && target.politicalView === scorer.politicalView) {
        score += config.politicalView.similarBonus;
    }
    if (target.educationLevel && scorer.educationLevel) {
        if (target.educationLevel >= scorer.educationLevel) {
            score += config.education.higherOrSameBonus.max;
        } else {
            score += config.education.lowerPenalty.min;
        }
    }
    if (target.religion && target.religion === scorer.religion) {
        score += config.religion.similarBonus;
    }
    const heightDiff = Math.abs(scorer.height - target.height);
    if (heightDiff < 5) score += config.height.maxBonus;
    else if (heightDiff < 10) score += config.height.minBonus;
    if (target.ethnicity && target.ethnicity === scorer.ethnicity) {
        score += config.ethnicity.similarBonus;
    }
    if (target.workplace && target.workplace === scorer.workplace) {
        score += config.workplace.sameBonus;
    }
    if (target.hasCompletedPrompts) score += config.profileCompletion.promptsFilledBonus;
    if (target.hasVoicePrompts) score += config.profileCompletion.voicePromptBonus;
    const substances = ['alcohol', 'smoking', 'marijuana'];
    substances.forEach(substance => {
        const scorerFreq = scorer[`${substance}Frequency`];
        const targetFreq = target[`${substance}Frequency`];
        if (scorerFreq === 'never' && targetFreq !== 'never') {
            score += config.substanceUse.mismatchPenalty;
        } else if (scorerFreq !== 'never' && targetFreq === 'never') {
            score += 0;
        } else {
            if (scorerFreq === targetFreq) {
                score += config.substanceUse.exactMatchBonus;
            } else {
                score += config.substanceUse.closeMatchBonus;
            }
        }
    });
    if (target.hometown && target.hometown === scorer.hometown) {
        score += config.hometown.sameBonus;
    }
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
            const docRef = db.collection('users').doc();
            batch.set(docRef, {
                age,
                gender,
                location: { lat, lon },
                geohash: geohash,
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
                    gender: gender === 'male' ? 'female' : 'male',
                    maxDistance: Math.floor(Math.random() * 41) + 10,
                }
            });
        }
        await batch.commit();
        res.status(200).send(`✅ Successfully created ${count} random users with geohash.`);
    } catch (err) {
        console.error("Error creating users:", err);
        res.status(500).send(`Error: ${err.message}`);
    }
});

exports.processMatches = onRequest({ timeoutSeconds: 540, memory: '1GiB' }, async (req, res) => {
    try {
        const today = new Date();
        const dateDocumentId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        const allUsersSnap = await db.collection('users').get();
        const users = allUsersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const dailyMatchesData = {};

        for (const uA of users) {
            if (!uA.location || !uA.preferences) continue;
            const prefsA = uA.preferences;
            const matches = [];

            const searchPrecision = getPrecisionForDistance(prefsA.maxDistance);
            const { minLat, minLon, maxLat, maxLon } = getBoundingBox(uA.location.lat, uA.location.lon, prefsA.maxDistance);
            const searchHashes = ngeohash.bboxes(minLat, minLon, maxLat, maxLon, searchPrecision);
            
            // 🚨 KALDIRILDI: Bu filtreleme hatalıydı. Yakındaki potansiyel eşleşmeleri de eliyordu.
            // const userAGeohashAtSearchPrecision = ngeohash.encode(uA.location.lat, uA.location.lon, searchPrecision);
            // searchHashes = searchHashes.filter(hash => hash !== userAGeohashAtSearchPrecision);

            if (searchHashes.length === 0) {
                dailyMatchesData[uA.id] = { matches: [] };
                continue;
            }

            // --- ✅ DÜZELTME: Hatalı 'in' sorgusu yerine doğru aralık sorgusu ('range query') mantığı ---
            // Her bir geohash alanı için paralel olarak sorgular yapıp sonuçları birleştireceğiz.
            const potentialMatchesDocs = [];
            const seenUserIds = new Set(); // Tekrarlanan kullanıcıları engellemek için

            const queryPromises = searchHashes.map(hash => {
                const start = hash;
                const end = hash + '~'; // Geohash aralık sorgusu için bitiş noktası

                return db.collection('users')
                    .where('gender', '==', prefsA.gender)
                    .where('age', '>=', prefsA.minAge)
                    .where('age', '<=', prefsA.maxAge)
                    .where('geohash', '>=', start)
                    .where('geohash', '<=', end)
                    .get();
            });

            // Tüm paralel sorguların bitmesini bekle
            const snapshots = await Promise.all(queryPromises);

            // Gelen sonuçları tek bir listeye, tekrarları engelleyerek ekle
            snapshots.forEach(snap => {
                snap.docs.forEach(doc => {
                    // Kullanıcıyı daha önce eklemediysek ve arama yapan kullanıcı değilse listeye ekle
                    if (!seenUserIds.has(doc.id) && doc.id !== uA.id) {
                        potentialMatchesDocs.push(doc);
                        seenUserIds.add(doc.id);
                    }
                });
            });

            for (const docB of potentialMatchesDocs) {
                const uB = { id: docB.id, ...docB.data() };
                // id kontrolü yukarıda yapıldı ama burada kalması zararsızdır.
                if (uA.id === uB.id) continue;

                // Ekstra mesafe kontrolü (Geohash kutusu tam daire olmadığı için gereklidir)
                const distance = calculateDistance(uA.location, uB.location);
                if (distance > prefsA.maxDistance) continue;

                // Karşılıklı uyumluluk kontrolü (B, A'nın kriterlerine uyuyor mu?)
                if (!checkCompatibility(uB, uA)) continue;

                const score = calculateScore(uA, uB);
                if (score > 0) {
                    matches.push({ uuid: uB.id, score });
                }
            }

            matches.sort((a, b) => b.score - a.score);
            dailyMatchesData[uA.id] = { matches };
        }

        const dateDocRef = db.collection('matches').doc(dateDocumentId);
        await dateDocRef.set(dailyMatchesData);

        return res.status(200).json({
            status: "success",
            message: `✅ Successfully generated DYNAMIC GEOHASH-based matches for ${users.length} users.`,
            dateDocumentId: dateDocumentId
        });
    } catch (error) {
        console.error("Geohash matching error:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});


exports.createCouplesFromMatches = onRequest({ timeoutSeconds: 300, memory: '1GiB' }, async (req, res) => {
    try {
        const today = new Date();
        const dateDocumentId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const dateDocRef = db.collection('matches').doc(dateDocumentId);
        const couplesDocRef = db.collection('couples').doc(dateDocumentId);

        const docSnap = await dateDocRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({
                status: "error",
                message: `Match document for ${dateDocumentId} not found. Run processMatches first.`,
            });
        }
        const dailyMatchesData = docSnap.data();
        const allPotentialPairs = [];
        const checkedPairs = new Set();
        for (const userIdA in dailyMatchesData) {
            const userAMatches = dailyMatchesData[userIdA].matches || [];
            for (const match of userAMatches) {
                const userIdB = match.uuid;
                const scoreAtoB = match.score;
                const pairKey = [userIdA, userIdB].sort().join('-');
                if (checkedPairs.has(pairKey)) {
                    continue;
                }
                checkedPairs.add(pairKey);
                const userBMatches = dailyMatchesData[userIdB]?.matches || [];
                const matchFromBtoA = userBMatches.find(m => m.uuid === userIdA);
                const scoreBtoA = matchFromBtoA ? matchFromBtoA.score : 0;
                const mutualScore = scoreAtoB + scoreBtoA;
                if (mutualScore > 0) {
                    allPotentialPairs.push({
                        pair: [userIdA, userIdB],
                        mutualScore: mutualScore,
                    });
                }
            }
        }
        allPotentialPairs.sort((a, b) => b.mutualScore - a.mutualScore);
        const matchedUsers = new Set();
        const finalCouplesMap = {};
        for (const potentialPair of allPotentialPairs) {
            const [user1, user2] = potentialPair.pair;
            if (!matchedUsers.has(user1) && !matchedUsers.has(user2)) {
                const mutualScore = potentialPair.mutualScore;
                finalCouplesMap[user1] = { partnerId: user2, mutualScore };
                finalCouplesMap[user2] = { partnerId: user1, mutualScore };
                matchedUsers.add(user1);
                matchedUsers.add(user2);
            }
        }
        await couplesDocRef.set({
            couples: finalCouplesMap,
            couplingCompletedAt: new Date().toISOString(),
        });
        const numberOfCouples = matchedUsers.size / 2;
        return res.status(200).json({
            status: "success",
            message: `Successfully created ${numberOfCouples} couples.`,
            dateDocumentId: dateDocumentId,
        });
    } catch (error) {
        console.error("Coupling error:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});